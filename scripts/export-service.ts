import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    APS_BUCKET_KEY,
    APS_REGION,
    WorkItemInput,
    buildOssObjectUrn,
    deleteBucketObjects,
    downloadBucketObject,
    ensureBucket,
    getInputLocalName,
    getQualifiedActivityId,
    getThreeLeggedToken,
    getTwoLeggedToken,
    inferInputFormat,
    uploadBucketObject,
    type InputFormat,
    type OssWorkItemInput,
} from "./aps-common";

export const TERMINAL_WORKITEM_STATUSES = new Set([
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

export interface ExportJob {
    jobId: string;
    workItemId: string;
    inputObjectKey: string;
    outputObjectKey: string;
    inputFormat: InputFormat;
    status: string;
    reportUrl?: string;
    createdAt: number;
}

export function isTerminalWorkItemStatus(status: string): boolean {
    return TERMINAL_WORKITEM_STATUSES.has(status);
}

export async function createWorkItem(
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
                  inputLocalName: getInputLocalName(input.inputFormat),
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
                "Hub exports require a 3-legged OAuth token."
            );
        }

        argumentsPayload.adsk3LeggedToken = threeLeggedToken;
    }

    if (!APS_BUCKET_KEY) {
        throw new Error("APS_BUCKET_KEY is required for exports.");
    }

    if (input.mode === "oss") {
        const inputArgumentName =
            input.inputFormat === "step" ? "InputStep" : "InputF3d";

        argumentsPayload[inputArgumentName] = {
            verb: "get",
            url: buildOssObjectUrn(APS_BUCKET_KEY, input.inputObjectKey),
            headers: {
                Authorization: `Bearer ${token}`,
            },
        };
    }

    argumentsPayload.OutputZip = {
        verb: "put",
        url: buildOssObjectUrn(APS_BUCKET_KEY, outputObjectKey),
        headers: {
            Authorization: `Bearer ${token}`,
        },
    };

    const url =
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/workitems`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            activityId,
            arguments: argumentsPayload,
        }),
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to create WorkItem: ${response.status}\n${text}`
        );
    }

    return JSON.parse(text) as {
        id?: string;
        status?: string;
        reportUrl?: string;
    };
}

export async function getWorkItemStatus(
    token: string,
    workItemId: string
) {
    const url =
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/workitems/${workItemId}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to get WorkItem status: ${response.status}\n${text}`
        );
    }

    return JSON.parse(text) as {
        id?: string;
        status?: string;
        reportUrl?: string;
    };
}

export async function fetchWorkItemReport(
    reportUrl: string
): Promise<string | null> {
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

export async function waitForWorkItem(
    token: string,
    workItemId: string,
    pollIntervalMs = 5000
) {
    let lastStatus: string | undefined;

    while (true) {
        const data = await getWorkItemStatus(token, workItemId);

        if (data.status && isTerminalWorkItemStatus(data.status)) {
            return data;
        }

        if (data.status !== lastStatus) {
            console.log(
                `WorkItem is still ${data.status ?? "unknown"}. Waiting...`
            );
            lastStatus = data.status;
        }

        await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, pollIntervalMs)
        );
    }
}

function requireBucketKey(): string {
    if (!APS_BUCKET_KEY) {
        throw new Error("APS_BUCKET_KEY is required.");
    }

    return APS_BUCKET_KEY;
}

export async function uploadOssInputFromPath(
    token: string,
    inputPath: string
): Promise<OssWorkItemInput> {
    const resolvedPath = resolve(inputPath);

    if (!existsSync(resolvedPath)) {
        throw new Error(`Input file not found: ${resolvedPath}`);
    }

    const bucketKey = requireBucketKey();
    const inputFormat = inferInputFormat(resolvedPath);
    const inputObjectKey =
        `inputs/${randomUUID()}${extname(resolvedPath)}`;

    console.log(`Uploading ${basename(resolvedPath)} to OSS...`);

    await uploadBucketObject(
        token,
        bucketKey,
        inputObjectKey,
        resolvedPath
    );

    console.log(
        "Uploaded:",
        buildOssObjectUrn(bucketKey, inputObjectKey)
    );

    return {
        inputObjectKey,
        inputFormat,
    };
}

export async function uploadOssInputFromBuffer(
    token: string,
    bytes: Buffer,
    filename: string
): Promise<OssWorkItemInput> {
    const bucketKey = requireBucketKey();
    const inputFormat = inferInputFormat(filename);
    const inputObjectKey =
        `inputs/${randomUUID()}${extname(filename)}`;

    const tempDir = mkdtempSync(join(tmpdir(), "batch-export-"));
    const tempPath = join(tempDir, basename(filename));

    try {
        writeFileSync(tempPath, bytes);

        await uploadBucketObject(
            token,
            bucketKey,
            inputObjectKey,
            tempPath
        );
    } finally {
        try {
            unlinkSync(tempPath);
        } catch {
            // ignore
        }
    }

    return {
        inputObjectKey,
        inputFormat,
    };
}

export async function submitOssExportJob(
    ossInput: OssWorkItemInput
): Promise<ExportJob> {
    const token = await getTwoLeggedToken();
    const bucketKey = requireBucketKey();

    await ensureBucket(token, bucketKey);

    const outputObjectKey = `exports/${randomUUID()}.zip`;

    const workItem = await createWorkItem(
        token,
        {
            mode: "oss",
            ...ossInput,
        },
        outputObjectKey
    );

    if (!workItem.id) {
        throw new Error("APS did not return a WorkItem ID.");
    }

    return {
        jobId: randomUUID(),
        workItemId: workItem.id,
        inputObjectKey: ossInput.inputObjectKey,
        outputObjectKey,
        inputFormat: ossInput.inputFormat,
        status: workItem.status ?? "pending",
        reportUrl: workItem.reportUrl,
        createdAt: Date.now(),
    };
}

export async function refreshExportJob(
    job: ExportJob
): Promise<ExportJob> {
    const token = await getTwoLeggedToken();
    const status = await getWorkItemStatus(token, job.workItemId);

    return {
        ...job,
        status: status.status ?? job.status,
        reportUrl: status.reportUrl ?? job.reportUrl,
    };
}

export async function downloadExportZip(
    outputObjectKey: string,
    destinationPath: string
): Promise<void> {
    const token = await getTwoLeggedToken();

    await downloadBucketObject(
        token,
        requireBucketKey(),
        outputObjectKey,
        destinationPath
    );
}

export async function cleanupExportJobOss(
    job: ExportJob,
    options?: { keepOss?: boolean }
): Promise<void> {
    if (options?.keepOss) {
        return;
    }

    const objectKeys = [job.outputObjectKey];

    if (job.inputObjectKey) {
        objectKeys.push(job.inputObjectKey);
    }

    const token = await getTwoLeggedToken();

    await deleteBucketObjects(token, requireBucketKey(), objectKeys);
}

export function interpretWorkItemFailure(
    status: string,
    report: string | null
): string {
    const reportText = report ?? "";

    if (
        reportText.includes("BEARER_TOKEN_GENERATION_FAILURE") ||
        reportText.includes("does not satisfy either OBO scope set")
    ) {
        return (
            "WorkItem failed because the 3LO token is missing " +
            "required Fusion Team scopes."
        );
    }

    return `WorkItem failed with status: ${status}`;
}

export async function getTwoLeggedTokenForExport(): Promise<string> {
    return getTwoLeggedToken();
}

export async function getThreeLeggedTokenForExport(
    explicitToken?: string
): Promise<string> {
    return getThreeLeggedToken(explicitToken);
}
