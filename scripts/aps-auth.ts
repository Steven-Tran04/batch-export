import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
    APS_3LO_SCOPES,
    APS_CALLBACK_URL,
    APS_CLIENT_ID,
    clearTokenCache,
    exchangeAuthorizationCode,
    requireApsCredentials,
    tryRefreshThreeLeggedToken,
} from "./aps-common";

import {
    getCliValue,
    hasCliFlag,
    parseCliArgs,
} from "./cli-args";
import {
    ensurePortAvailable,
    getListeningPid,
    getProcessName,
} from "./port-utils";

const ROOT = resolve(import.meta.dirname, "..");

function resolveCallbackUrl(argv: string[]): string {
    const portOverride = getCliValue(
        parseCliArgs(argv),
        "port"
    );

    if (!portOverride) {
        return APS_CALLBACK_URL;
    }

    const callbackUrl = new URL(APS_CALLBACK_URL);
    callbackUrl.port = portOverride;

    return callbackUrl.toString();
}

function formatPortInUseError(
    port: number,
    callbackUrl: string,
    pid: number | null,
    processName: string | null
): string {
    const owner =
        pid != null
            ? `${processName ?? "process"} (PID ${pid})`
            : "another process";

    return (
        `Port ${port} is already in use by ${owner}, so the OAuth ` +
        `callback server could not start.\n\n` +
        `Callback URL: ${callbackUrl}\n\n` +
        `Fix options:\n` +
        `  1. Stop the process and retry:\n` +
        `       npm run auth -- --replace\n` +
        (pid != null && process.platform === "win32"
            ? `     or: taskkill /PID ${pid} /F\n`
            : "") +
        `  2. Use another registered callback port:\n` +
        `       npm run auth -- --port 8081`
    );
}

function openBrowser(url: string): void {
    if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", url], {
            detached: true,
            stdio: "ignore",
        }).unref();
        return;
    }

    const command =
        process.platform === "darwin" ? "open" : "xdg-open";

    spawn(command, [url], {
        detached: true,
        stdio: "ignore",
    }).unref();
}

function buildAuthorizeUrl(
    callbackUrl: string,
    state: string
): string {
    const params = new URLSearchParams({
        response_type: "code",
        client_id: APS_CLIENT_ID!,
        redirect_uri: callbackUrl,
        scope: APS_3LO_SCOPES,
        state,
    });

    return `https://developer.api.autodesk.com/authentication/v2/authorize?${params}`;
}

async function waitForAuthorizationCode(
    callbackUrl: string,
    replaceExistingListener: boolean
): Promise<string> {
    const parsedCallbackUrl = new URL(callbackUrl);
    const callbackPath = parsedCallbackUrl.pathname || "/";
    const port =
        parsedCallbackUrl.port !== ""
            ? Number(parsedCallbackUrl.port)
            : parsedCallbackUrl.protocol === "https:"
              ? 443
              : 80;
    const loginUrl = `http://localhost:${port}/`;

    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(
            `Invalid callback URL port: ${callbackUrl}`
        );
    }

    ensurePortAvailable(port, replaceExistingListener);

    const state = randomUUID();

    return new Promise((resolvePromise, rejectPromise) => {
        const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
        let settled = false;

        const server = createServer(async (request, response) => {
            try {
                const requestUrl = new URL(
                    request.url ?? "/",
                    loginUrl
                );

                if (
                    request.method !== "GET" &&
                    request.method !== "HEAD"
                ) {
                    response.writeHead(405, {
                        "Content-Type": "text/plain",
                    });
                    response.end("Method not allowed");
                    return;
                }

                if (requestUrl.pathname === "/") {
                    const authorizeUrl = buildAuthorizeUrl(
                        callbackUrl,
                        state
                    );

                    response.writeHead(302, {
                        Location: authorizeUrl,
                    });
                    response.end();
                    return;
                }

                if (requestUrl.pathname !== callbackPath) {
                    response.writeHead(404, {
                        "Content-Type": "text/plain",
                    });
                    response.end("Not found");
                    return;
                }

                const error = requestUrl.searchParams.get("error");
                const code = requestUrl.searchParams.get("code");
                const returnedState =
                    requestUrl.searchParams.get("state");

                if (error) {
                    throw new Error(
                        `Authorization denied: ${error}`
                    );
                }

                if (!code) {
                    throw new Error(
                        "Authorization response did not include a code."
                    );
                }

                if (returnedState !== state) {
                    throw new Error(
                        "Authorization state mismatch."
                    );
                }

                await exchangeAuthorizationCode(callbackUrl, code);

                response.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                });
                response.end(
                    "<html><body><h1>Autodesk authentication successful</h1>" +
                        "<p>You can close this browser window.</p>" +
                        "</body></html>"
                );

                settled = true;
                clearTimeout(timeout);
                server.close();
                resolvePromise(code);
            } catch (error) {
                response.writeHead(500, {
                    "Content-Type": "text/plain",
                });
                response.end(String(error));

                settled = true;
                clearTimeout(timeout);
                server.close();
                rejectPromise(error);
            }
        });

        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            server.close();
            rejectPromise(
                new Error(
                    "Timed out waiting for OAuth callback after 10 minutes."
                )
            );
        }, AUTH_TIMEOUT_MS);

        server.listen(port, () => {
            console.log("");
            console.log(
                "================================================"
            );
            console.log("Autodesk authentication required.");
            console.log(`Open ${loginUrl} in a web browser.`);
            console.log(
                "After sign-in, APS will redirect to:",
                callbackUrl
            );
            console.log(
                "================================================"
            );
            console.log("");

            openBrowser(loginUrl);
        });

        server.on("error", (error: NodeJS.ErrnoException) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);

            if (error.code === "EADDRINUSE") {
                const pid = getListeningPid(port);

                rejectPromise(
                    new Error(
                        formatPortInUseError(
                            port,
                            callbackUrl,
                            pid,
                            pid != null ? getProcessName(pid) : null
                        )
                    )
                );
                return;
            }

            rejectPromise(error);
        });

        const shutdown = () => {
            server.close();
        };

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    });
}

async function main(): Promise<void> {
    requireApsCredentials();

    const argv = process.argv.slice(2);
    const args = parseCliArgs(argv);
    const callbackUrl = resolveCallbackUrl(argv);
    const replaceExistingListener = hasCliFlag(args, "replace");
    const forceReauth = hasCliFlag(args, "force");

    if (!callbackUrl) {
        throw new Error(
            "Missing APS_CALLBACK_URL in .env. " +
                "Example: http://localhost:8080/callback/oauth"
        );
    }

    console.log("Checking for a saved refresh token...");

    if (forceReauth) {
        console.log(
            "Force re-auth requested. Clearing saved token cache..."
        );
        clearTokenCache();
    }

    const refreshed =
        forceReauth ? null : await tryRefreshThreeLeggedToken();

    if (refreshed) {
        console.log(
            "Access token refreshed silently. No browser login required."
        );
        console.log("Saved token cache is ready for `npm run export`.");
        return;
    }

    console.log(
        "Starting one-time 3-legged OAuth sign-in..."
    );
    console.log(`Callback URL: ${callbackUrl}`);
    console.log(`3LO scopes: ${APS_3LO_SCOPES}`);
    console.log(`Project root: ${ROOT}`);

    await waitForAuthorizationCode(
        callbackUrl,
        replaceExistingListener
    );

    console.log("\nSaved refresh token to .aps-token.json");
    console.log("Authorization finished successfully.");
}

main().catch((error) => {
    console.error("\nAuthorization failed:");
    console.error(error);
    process.exit(1);
});
