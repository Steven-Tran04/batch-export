import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
    APS_BUCKET_KEY,
    APS_REGION,
    WorkItemInput,
    buildOssObjectUrn,
    downloadBucketObject,
    ensureBucket,
    getInputLocalName,
    getQualifiedActivityId,
    getThreeLeggedToken,
    getTwoLeggedToken,
    inferInputFormat,
    resolveWorkItemTarget,
    uploadBucketObject,
} from "./aps-common";
import { getCliValue, parseCliArgs } from "./cli-args";

async function createWorkItem(
    token: string,
    input: WorkItemInput,
    outputObjectKey: string,
    threeLeggedToken?: string
) {
    const activityId = getQualifiedActivityId();

    const taskParameters =
        input.mode === "oss"
            ? {
                  inputSource: "oss",
                  inputFormat: input.inputFormat,
                  inputLocalName: getInputLocalName(
                      input.inputFormat
                  ),
              }
            : {
                  hubId: input.hubId,
                  fileURN: input.fileURN,
              };

    const argumentsPayload: Record<string, unknown> = {
        TaskParameters: JSON.stringify(taskParameters),
    };

    if (input.mode === "hub") {
        if (!threeLeggedToken) {
            throw new Error(
                "Hub exports require a 3-legged OAuth token. Run `npm run auth`."
            );
        }

        argumentsPayload.adsk3LeggedToken = threeLeggedToken;
    }

    if (APS_BUCKET_KEY) {
        if (input.mode === "oss") {
            const inputArgumentName =
                input.inputFormat === "step"
                    ? "InputStep"
                    : "InputF3d";

            argumentsPayload[inputArgumentName] = {
                verb: "get",
                url: buildOssObjectUrn(
                    APS_BUCKET_KEY,
                    input.inputObjectKey
                ),
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            };
        }

        argumentsPayload.OutputZip = {
            verb: "put",
            url: buildOssObjectUrn(
                APS_BUCKET_KEY,
                outputObjectKey
            ),
            headers: {
                Authorization: `Bearer ${token}`,
            },
        };
    }

    const workItem = {
        activityId,
        arguments: argumentsPayload,
    };

    const url =
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/workitems`;

    console.log("Submitting WorkItem...");
    console.log("Activity:", activityId);
    console.log("Input mode:", input.mode);
    console.log("TaskParameters:", taskParameters);

    if (APS_BUCKET_KEY) {
        if (input.mode === "oss") {
            console.log(
                "Input file:",
                buildOssObjectUrn(
                    APS_BUCKET_KEY,
                    input.inputObjectKey
                )
            );
        }

        console.log(
            "Output zip:",
            buildOssObjectUrn(
                APS_BUCKET_KEY,
                outputObjectKey
            )
        );
    } else {
        console.log(
            "No APS_BUCKET_KEY set. STEP files will only exist in the workitem report."
        );
    }

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(workItem),
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to create WorkItem: ${response.status}\n${text}`
        );
    }

    const data = JSON.parse(text);

    console.log("\nWorkItem submitted successfully.");
    console.log("WorkItem ID:", data.id);
    console.log("Status:", data.status);

    return data;
}

async function getWorkItemStatus(
    token: string,
    workItemId: string
) {
    const url =
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/workitems/${workItemId}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to get WorkItem status: ${response.status}\n${text}`
        );
    }

    return JSON.parse(text);
}

const TERMINAL_WORKITEM_STATUSES = new Set([
    "success",
    "failed",
    "cancelled",
    "failedDownload",
    "failedUpload",
    "failedInstructions",
    "failedLimitProcessingTime",
    "failedLimitDataSize",
    "failedMissingOutput",
]);

async function fetchWorkItemReport(reportUrl: string): Promise<string | null> {
    try {
        const response = await fetch(reportUrl);

        if (!response.ok) {
            return null;
        }

        return await response.text();
    } catch {
        return null;
    }
}

async function waitForWorkItem(
    token: string,
    workItemId: string
) {
    const POLL_INTERVAL_MS = 5000;
    let lastStatus: string | undefined;

    while (true) {
        const data = await getWorkItemStatus(
            token,
            workItemId
        );

        if (TERMINAL_WORKITEM_STATUSES.has(data.status)) {
            return data;
        }

        if (data.status !== lastStatus) {
            console.log(
                `WorkItem is still ${data.status}. Waiting...`
            );
            lastStatus = data.status;
        }

        await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, POLL_INTERVAL_MS)
        );
    }
}

async function resolveWorkItemInput(
    args: Map<string, string | true>,
    token: string
): Promise<WorkItemInput> {
    const inputPath = getCliValue(args, "input");
    const existingObjectKey = getCliValue(args, "oss-key");

    if (inputPath || existingObjectKey) {
        if (!APS_BUCKET_KEY) {
            throw new Error(
                "OSS input requires APS_BUCKET_KEY in .env."
            );
        }

        if (inputPath) {
            const resolvedPath = resolve(inputPath);

            if (!existsSync(resolvedPath)) {
                throw new Error(
                    `Input file not found: ${resolvedPath}`
                );
            }

            const inputFormat = inferInputFormat(resolvedPath);
            const inputObjectKey =
                `inputs/${randomUUID()}${extname(resolvedPath)}`;

            console.log(
                `Uploading ${basename(resolvedPath)} to OSS...`
            );

            await uploadBucketObject(
                token,
                APS_BUCKET_KEY,
                inputObjectKey,
                resolvedPath
            );

            console.log(
                "Uploaded:",
                buildOssObjectUrn(
                    APS_BUCKET_KEY,
                    inputObjectKey
                )
            );

            return {
                mode: "oss",
                inputObjectKey,
                inputFormat,
            };
        }

        const inputFormat = inferInputFormat(existingObjectKey!);

        console.log(
            "Using existing OSS input:",
            buildOssObjectUrn(
                APS_BUCKET_KEY,
                existingObjectKey!
            )
        );

        return {
            mode: "oss",
            inputObjectKey: existingObjectKey!,
            inputFormat,
        };
    }

    const target = resolveWorkItemTarget();

    return {
        mode: "hub",
        hubId: target.hubId,
        fileURN: target.fileURN,
    };
}

async function main() {
    const args = parseCliArgs(process.argv.slice(2));
    const inputPath = getCliValue(args, "input");
    const existingObjectKey = getCliValue(args, "oss-key");
    const usesOssInput = Boolean(inputPath || existingObjectKey);

    console.log("Getting APS access token...");

    const token = await getTwoLeggedToken();

    if (APS_BUCKET_KEY) {
        console.log(`Ensuring OSS bucket ${APS_BUCKET_KEY} exists...`);
        await ensureBucket(token, APS_BUCKET_KEY);
    }

    const input = await resolveWorkItemInput(args, token);

    const threeLeggedToken = usesOssInput
        ? undefined
        : await getThreeLeggedToken(getCliValue(args, "token"));

    const outputObjectKey =
        `exports/${randomUUID()}.zip`;

    const workItem = await createWorkItem(
        token,
        input,
        outputObjectKey,
        threeLeggedToken
    );

    if (!workItem.id) {
        throw new Error(
            "APS did not return a WorkItem ID."
        );
    }

    const finalStatus = await waitForWorkItem(
        token,
        workItem.id
    );

    console.log("\n================================");
    console.log("WorkItem finished");
    console.log("================================");

    console.log("ID:", finalStatus.id);
    console.log("Status:", finalStatus.status);

    let report: string | null = null;

    if (finalStatus.reportUrl) {
        console.log("Report URL:", finalStatus.reportUrl);

        report = await fetchWorkItemReport(
            finalStatus.reportUrl
        );

        if (report) {
            console.log("\nWorkItem report:\n");
            console.log(report);
        }
    }

    if (finalStatus.status !== "success") {
        const reportText = report ?? "";

        if (
            reportText.includes(
                "BEARER_TOKEN_GENERATION_FAILURE"
            ) ||
            reportText.includes("does not satisfy either OBO scope set")
        ) {
            throw new Error(
                "WorkItem failed because the saved 3LO token is missing " +
                    "required Fusion Team scopes. Re-authenticate, then retry:\n" +
                    "  npm run auth -- --force --replace\n" +
                    "  npm run export"
            );
        }

        throw new Error(
            `WorkItem failed with status: ${finalStatus.status}`
        );
    }

    if (APS_BUCKET_KEY) {
        const outputPath = join(
            resolve(import.meta.dirname, ".."),
            "output",
            `${workItem.id}.zip`
        );

        console.log(
            "\nDownloading exported STEP zip from OSS..."
        );

        mkdirSync(dirname(outputPath), { recursive: true });

        await downloadBucketObject(
            token,
            APS_BUCKET_KEY,
            outputObjectKey,
            outputPath
        );

        console.log("Saved:", outputPath);
    }

    console.log("\nWorkItem completed successfully.");
}

main().catch((error) => {
    console.error("\nWorkItem execution failed:");
    console.error(error);

    process.exit(1);
});
