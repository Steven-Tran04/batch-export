import { createHmac, timingSafeEqual } from "node:crypto";

import { APS_CLIENT_SECRET, type InputFormat } from "./aps-common";

const TOKEN_TTL_MS = 45 * 60 * 1000;

export interface JobTokenPayload {
    inputObjectKey: string;
    outputObjectKey: string;
    inputFormat: InputFormat;
    uploadKey?: string;
    workItemId?: string;
    exp: number;
}

function signingSecret(): string {
    const secret = process.env.JOB_TOKEN_SECRET ?? APS_CLIENT_SECRET;

    if (!secret) {
        throw new Error(
            "JOB_TOKEN_SECRET or APS_CLIENT_SECRET is required to sign job tokens."
        );
    }

    return secret;
}

function toBase64Url(value: Buffer | string): string {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    return buffer.toString("base64url");
}

function signPayload(encodedPayload: string): string {
    return createHmac("sha256", signingSecret())
        .update(encodedPayload)
        .digest("base64url");
}

export function createJobToken(
    payload: Omit<JobTokenPayload, "exp"> & { exp?: number }
): string {
    const body: JobTokenPayload = {
        ...payload,
        exp: payload.exp ?? Date.now() + TOKEN_TTL_MS,
    };
    const encodedPayload = toBase64Url(JSON.stringify(body));
    return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function readJobToken(token: string): JobTokenPayload {
    const [encodedPayload, signature] = token.split(".");

    if (!encodedPayload || !signature) {
        throw new Error("Invalid job token.");
    }

    const expected = signPayload(encodedPayload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
        throw new Error("Invalid job token.");
    }

    const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as JobTokenPayload;

    if (payload.exp <= Date.now()) {
        throw new Error("Job token expired.");
    }

    return payload;
}
