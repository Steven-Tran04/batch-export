import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import {
    APS_BUCKET_KEY,
    OSS_MAX_UPLOAD_PARTS_PER_REQUEST,
    OSS_UPLOAD_PART_SIZE,
    completeSignedOssUpload,
    createSignedOssUpload,
    ensureBucket,
    getSignedOssDownload,
    getTwoLeggedToken,
    inferInputFormat,
} from "./aps-common";
import {
    cleanupExportJobOss,
    createWorkItem,
    isTerminalWorkItemStatus,
    refreshExportJob,
    type ExportJob,
} from "./export-service";
import { createJobToken, readJobToken } from "./job-token";

interface LambdaHttpEvent {
    rawPath?: string;
    requestContext?: {
        http?: {
            method?: string;
        };
    };
    headers?: Record<string, string | undefined>;
    body?: string | null;
    isBase64Encoded?: boolean;
}

interface JsonRequest {
    filename?: string;
    sizeBytes?: number;
    jobToken?: string;
}

const MAX_UPLOAD_BYTES =
    OSS_UPLOAD_PART_SIZE * OSS_MAX_UPLOAD_PARTS_PER_REQUEST;

function jsonResponse(
    statusCode: number,
    body: unknown
): { statusCode: number; headers: Record<string, string>; body: string } {
    return {
        statusCode,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    };
}

function requireBucketKey(): string {
    if (!APS_BUCKET_KEY) {
        throw new Error("APS_BUCKET_KEY is required.");
    }

    return APS_BUCKET_KEY;
}

function parseBody(event: LambdaHttpEvent): JsonRequest {
    if (!event.body) {
        return {};
    }

    const text = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;

    return JSON.parse(text) as JsonRequest;
}

function jobFromToken(
    payload: ReturnType<typeof readJobToken>
): ExportJob {
    if (!payload.workItemId) {
        throw new Error("Export has not been submitted yet.");
    }

    return {
        jobId: payload.workItemId,
        workItemId: payload.workItemId,
        inputObjectKey: payload.inputObjectKey,
        outputObjectKey: payload.outputObjectKey,
        inputFormat: payload.inputFormat,
        status: "unknown",
        createdAt: Date.now(),
    };
}

async function handleUploads(request: JsonRequest) {
    if (!request.filename || typeof request.sizeBytes !== "number") {
        throw new Error("filename and sizeBytes are required.");
    }

    if (request.sizeBytes <= 0) {
        throw new Error("sizeBytes must be greater than 0.");
    }

    if (request.sizeBytes > MAX_UPLOAD_BYTES) {
        throw new Error(
            `File is too large for this Lambda (max ${MAX_UPLOAD_BYTES} bytes).`
        );
    }

    const inputFormat = inferInputFormat(request.filename);
    const inputObjectKey =
        `inputs/${randomUUID()}${extname(request.filename)}`;
    const outputObjectKey = `exports/${randomUUID()}.zip`;
    const parts = Math.max(
        1,
        Math.ceil(request.sizeBytes / OSS_UPLOAD_PART_SIZE)
    );

    const apsToken = await getTwoLeggedToken();
    const bucketKey = requireBucketKey();
    await ensureBucket(apsToken, bucketKey);

    const signed = await createSignedOssUpload(
        apsToken,
        bucketKey,
        inputObjectKey,
        { parts }
    );

    const jobToken = createJobToken({
        inputObjectKey,
        outputObjectKey,
        inputFormat,
        uploadKey: signed.uploadKey,
    });

    return {
        jobToken,
        inputObjectKey,
        partSize: OSS_UPLOAD_PART_SIZE,
        urls: signed.urls,
    };
}

async function handleJobs(request: JsonRequest) {
    if (!request.jobToken) {
        throw new Error("jobToken is required.");
    }

    const payload = readJobToken(request.jobToken);

    if (!payload.uploadKey) {
        throw new Error("Upload session is missing from the job token.");
    }

    const apsToken = await getTwoLeggedToken();
    const bucketKey = requireBucketKey();

    await completeSignedOssUpload(
        apsToken,
        bucketKey,
        payload.inputObjectKey,
        payload.uploadKey
    );

    const workItem = await createWorkItem(
        apsToken,
        {
            mode: "oss",
            inputObjectKey: payload.inputObjectKey,
            inputFormat: payload.inputFormat,
        },
        payload.outputObjectKey
    );

    if (!workItem.id) {
        throw new Error("APS did not return a WorkItem ID.");
    }

    const jobToken = createJobToken({
        inputObjectKey: payload.inputObjectKey,
        outputObjectKey: payload.outputObjectKey,
        inputFormat: payload.inputFormat,
        workItemId: workItem.id,
        exp: payload.exp,
    });

    return {
        jobToken,
        workItemId: workItem.id,
        status: workItem.status ?? "pending",
    };
}

async function handleStatus(request: JsonRequest) {
    if (!request.jobToken) {
        throw new Error("jobToken is required.");
    }

    const payload = readJobToken(request.jobToken);
    const job = await refreshExportJob(jobFromToken(payload));

    return {
        status: job.status,
        done: isTerminalWorkItemStatus(job.status),
        reportUrl: job.reportUrl,
    };
}

async function handleDownload(request: JsonRequest) {
    if (!request.jobToken) {
        throw new Error("jobToken is required.");
    }

    const payload = readJobToken(request.jobToken);
    const job = await refreshExportJob(jobFromToken(payload));

    if (job.status !== "success") {
        throw new Error(
            `Export is not ready to download (status: ${job.status}).`
        );
    }

    const signed = await getSignedOssDownload(
        await getTwoLeggedToken(),
        requireBucketKey(),
        payload.outputObjectKey
    );

    return {
        url: signed.url,
        status: signed.status,
        urls: signed.urls,
        size: signed.size,
    };
}

async function handleCleanup(request: JsonRequest) {
    if (!request.jobToken) {
        throw new Error("jobToken is required.");
    }

    const payload = readJobToken(request.jobToken);
    await cleanupExportJobOss({
        jobId: payload.workItemId ?? payload.inputObjectKey,
        workItemId: payload.workItemId ?? "",
        inputObjectKey: payload.inputObjectKey,
        outputObjectKey: payload.outputObjectKey,
        inputFormat: payload.inputFormat,
        status: "unknown",
        createdAt: Date.now(),
    });
    return { ok: true };
}

export async function handler(event: LambdaHttpEvent) {
    const method =
        event.requestContext?.http?.method?.toUpperCase() ?? "GET";
    const path = (event.rawPath ?? "/").replace(/\/+$/, "") || "/";

    try {
        if (method === "GET" && path === "/") {
            return jsonResponse(200, {
                ok: true,
                service: "batch-export",
            });
        }

        if (method !== "POST") {
            return jsonResponse(405, { error: "Method not allowed." });
        }

        const request = parseBody(event);

        if (path === "/uploads") {
            return jsonResponse(200, await handleUploads(request));
        }

        if (path === "/jobs") {
            return jsonResponse(200, await handleJobs(request));
        }

        if (path === "/status") {
            return jsonResponse(200, await handleStatus(request));
        }

        if (path === "/download") {
            return jsonResponse(200, await handleDownload(request));
        }

        if (path === "/cleanup") {
            return jsonResponse(200, await handleCleanup(request));
        }

        return jsonResponse(404, { error: "Not found." });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Request failed.";
        const statusCode = message.includes("Invalid job token")
            ? 401
            : message.includes("expired")
              ? 401
              : 400;

        return jsonResponse(statusCode, { error: message });
    }
}
