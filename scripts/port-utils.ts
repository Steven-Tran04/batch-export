import { execFileSync } from "node:child_process";

export function getListeningPid(port: number): number | null {
    if (process.platform === "win32") {
        const output = execFileSync(
            "netstat",
            ["-ano"],
            { encoding: "utf8" }
        );

        for (const line of output.split(/\r?\n/)) {
            if (!line.includes(`127.0.0.1:${port}`)) {
                continue;
            }

            if (!line.includes("LISTENING")) {
                continue;
            }

            const parts = line.trim().split(/\s+/);
            const pid = Number(parts[parts.length - 1]);

            if (Number.isFinite(pid) && pid > 0) {
                return pid;
            }
        }

        return null;
    }

    try {
        const output = execFileSync(
            "lsof",
            ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
            { encoding: "utf8" }
        ).trim();

        if (!output) {
            return null;
        }

        const pid = Number(output.split(/\s+/)[0]);
        return Number.isFinite(pid) ? pid : null;
    } catch {
        return null;
    }
}

export function getProcessName(pid: number): string | null {
    try {
        if (process.platform === "win32") {
            const output = execFileSync(
                "tasklist",
                ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
                { encoding: "utf8" }
            ).trim();

            if (!output || output.includes("No tasks")) {
                return null;
            }

            return output.split(",")[0]?.replace(/^"|"$/g, "") ?? null;
        }

        const output = execFileSync(
            "ps",
            ["-p", String(pid), "-o", "comm="],
            { encoding: "utf8" }
        ).trim();

        return output || null;
    } catch {
        return null;
    }
}

export function killProcess(pid: number): void {
    if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/F"], {
            stdio: "ignore",
        });
        return;
    }

    process.kill(pid, "SIGTERM");
}

export function ensurePortAvailable(
    port: number,
    replace = false
): void {
    const pid = getListeningPid(port);

    if (!pid) {
        return;
    }

    const processName = getProcessName(pid) ?? "unknown";

    if (!replace) {
        throw new Error(
            `Port ${port} is already in use by ${processName} (PID ${pid}).\n` +
                `Stop it and retry:\n` +
                (process.platform === "win32"
                    ? `  taskkill /PID ${pid} /F\n`
                    : `  kill ${pid}\n`) +
                `Or rerun with --replace to stop that process automatically:\n` +
                `  npm run auth -- --replace`
        );
    }

    console.log(
        `Stopping ${processName} (PID ${pid}) on port ${port}...`
    );
    killProcess(pid);
}
