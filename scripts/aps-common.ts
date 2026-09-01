import "dotenv/config";

import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { extname } from "node:path";
import { resolve } from "node:path";

import {
    getCliValue,
    parseCliArgs,
    resolveSetting,
} from "./cli-args";

const ROOT = resolve(import.meta.dirname, "..");
const TOKEN_CACHE_PATH = resolve(ROOT, ".aps-token.json");

/** Refresh 2-legged tokens this many ms before APS expiry. */
const TWO_LEGGED_EXPIRY_SKEW_MS = 60_000;

interface TwoLeggedTokenCache {
    access_token: string;
    expires_at: number;
}

let twoLeggedTokenCache: TwoLeggedTokenCache | null = null;
let twoLeggedTokenInFlight: Promise<string> | null = null;

export const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
export const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
export const APS_REGION = process.env.APS_REGION ?? "us-east";
export const APS_BUCKET_KEY = process.env.APS_BUCKET_KEY;
export const APS_CALLBACK_URL =
    process.env.APS_CALLBACK_URL ??
    "http://localhost:8080/callback/oauth";
export const APS_HUB_ID = process.env.APS_HUB_ID;
export const APS_FILE_URN = process.env.APS_FILE_URN;
export const APS_REFRESH_TOKEN = process.env.APS_REFRESH_TOKEN;
export const APS_NICKNAME = process.env.APS_NICKNAME;

export const ACTIVITY_ID = "BatchExportActivity";
export const ACTIVITY_ALIAS = "dev";
export const APPBUNDLE_ID = "BatchExportAppBundle";
export const APPBUNDLE_ALIAS = "dev";

/** Worker-local path for native Fusion archive OSS input. */
export const INPUT_F3D_LOCAL_NAME = "input.f3d";

/** Worker-local path for STEP OSS input. */
export const INPUT_STEP_LOCAL_NAME = "input.stp";

/** @deprecated Use INPUT_F3D_LOCAL_NAME or INPUT_STEP_LOCAL_NAME. */
export const INPUT_LOCAL_NAME = INPUT_F3D_LOCAL_NAME;

export function getInputLocalName(
    inputFormat: InputFormat
): string {
    return inputFormat === "step"
        ? INPUT_STEP_LOCAL_NAME
        : INPUT_F3D_LOCAL_NAME;
}

export type InputFormat = "f3d" | "step";

export interface OssWorkItemInput {
    inputObjectKey: string;
    inputFormat: InputFormat;
}

export interface HubWorkItemInput {
    hubId: string;
    fileURN: string;
}

export type WorkItemInput =
    | ({ mode: "oss" } & OssWorkItemInput)
    | ({ mode: "hub" } & HubWorkItemInput);

export function getQualifiedActivityId(): string {
    const owner = APS_NICKNAME ?? APS_CLIENT_ID;

    if (!owner) {
        throw new Error(
            "Missing APS_NICKNAME or APS_CLIENT_ID for activity lookup."
        );
    }

    return `${owner}.${ACTIVITY_ID}+${ACTIVITY_ALIAS}`;
}

export function getQualifiedAppBundleId(): string {
    const owner = APS_NICKNAME ?? APS_CLIENT_ID;

    if (!owner) {
        throw new Error(
            "Missing APS_NICKNAME or APS_CLIENT_ID for app bundle lookup."
        );
    }

    return `${owner}.${APPBUNDLE_ID}+${APPBUNDLE_ALIAS}`;
}

export const APS_SCOPES =
    "code:all data:read data:write data:create bucket:read bucket:create bucket:update";

/** OSS multipart upload chunk size (APS direct-to-S3). */
const OSS_UPLOAD_PART_SIZE = 5 * 1024 * 1024;

/** APS allows up to 25 signed upload URLs per request. */
const OSS_MAX_UPLOAD_PARTS_PER_REQUEST = 25;

/** Use parallel range downloads above this size. */
const OSS_PARALLEL_DOWNLOAD_THRESHOLD = 16 * 1024 * 1024;

/** Byte range size for parallel OSS downloads. */
const OSS_DOWNLOAD_PART_SIZE = 8 * 1024 * 1024;

/** Concurrent range requests when downloading large objects. */
const OSS_DOWNLOAD_CONCURRENCY = 6;

export interface SignedOssDownload {
    status?: string;
    url?: string;
    urls?: Record<string, string>;
    size?: number;
}

/**
 * Scopes for browser sign-in (3-legged OAuth). Must be valid APS scope names
 * enabled on your app (typically Data Management API). Do not include
 * client-credentials-only scopes such as code:all here.
 *
 * Override via APS_3LO_SCOPES in .env if needed.
 */
export const APS_3LO_SCOPES =
    process.env.APS_3LO_SCOPES ??
    "data:read data:write data:create account:read";

interface TokenCache {
    access_token?: string;
    refresh_token?: string;
    refreshToken?: string;
    expires_at?: number;
}

export interface WorkItemTarget {
    hubId: string;
    fileURN: string;
}

export function inferInputFormat(
    filePath: string
): InputFormat {
    const extension = extname(filePath).toLowerCase();

    if (extension === ".f3d") {
        return "f3d";
    }

    if (extension === ".step" || extension === ".stp") {
        return "step";
    }

    throw new Error(
        `Unsupported input file type "${extension}". ` +
            "Use .f3d, .step, or .stp."
    );
}

export function buildOssObjectUrn(
    bucketKey: string,
    objectKey: string
): string {
    return `urn:adsk.objects:os.object:${bucketKey}/${objectKey}`;
}

export function requireApsCredentials(): void {
    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
        throw new Error(
            "Missing APS_CLIENT_ID or APS_CLIENT_SECRET in .env"
        );
    }
}

export function saveTokenCache(cache: TokenCache): void {
    writeFileSync(
        TOKEN_CACHE_PATH,
        JSON.stringify(cache, null, 2),
        "utf8"
    );
}

export function clearTokenCache(): void {
    twoLeggedTokenCache = null;
    twoLeggedTokenInFlight = null;

    if (existsSync(TOKEN_CACHE_PATH)) {
        writeFileSync(TOKEN_CACHE_PATH, "{}", "utf8");
    }
}

function readTokenFile(filePath: string): TokenCache | null {
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        return JSON.parse(
            readFileSync(filePath, "utf8")
        ) as TokenCache;
    } catch {
        return null;
    }
}

function loadTokenCache(): TokenCache | null {
    return (
        readTokenFile(TOKEN_CACHE_PATH) ??
        readTokenFile(resolve(ROOT, "aps-tokens.json"))
    );
}

function getRefreshTokenFromCache(
    cache: TokenCache | null
): string | undefined {
    return cache?.refresh_token ?? cache?.refreshToken;
}

function getRefreshToken(): string | undefined {
    if (APS_REFRESH_TOKEN) {
        return APS_REFRESH_TOKEN;
    }

    return getRefreshTokenFromCache(loadTokenCache());
}

async function requestThreeLeggedToken(
    body: URLSearchParams
): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
}> {
    requireApsCredentials();

    body.set("client_id", APS_CLIENT_ID!);
    body.set("client_secret", APS_CLIENT_SECRET!);

    const response = await fetch(
        "https://developer.api.autodesk.com/authentication/v2/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
        }
    );

    const text = await response.text();

    if (!response.ok) {
        let message =
            `Failed to get APS 3-legged token: ${response.status}\n${text}`;

        if (text.includes("invalid_scope")) {
            message +=
                "\n\nOne or more OAuth scopes are invalid or were not granted " +
                "during sign-in. Fix options:\n" +
                "  1. Re-authenticate with the current scope list:\n" +
                "       npm run auth -- --force --replace\n" +
                "  2. Override scopes in .env, e.g.:\n" +
                "       APS_3LO_SCOPES=data:read data:write data:create\n" +
                `\nConfigured scopes: ${APS_3LO_SCOPES}`;
        }

        throw new Error(message);
    }

    return JSON.parse(text);
}

export async function exchangeAuthorizationCode(
    callbackUrl: string,
    code: string
): Promise<string> {
    const data = await requestThreeLeggedToken(
        new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: callbackUrl,
        })
    );

    if (!data.refresh_token) {
        throw new Error(
            "APS did not return a refresh_token. " +
                "Ensure your APS app uses the Authorization Code flow."
        );
    }

    saveTokenCache({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
    });

    return data.access_token;
}

export async function getThreeLeggedToken(
    explicitToken?: string
): Promise<string> {
    if (explicitToken) {
        return explicitToken;
    }

    const cache = loadTokenCache();

    if (
        cache?.access_token &&
        cache.expires_at &&
        cache.expires_at > Date.now() + 60_000
    ) {
        return cache.access_token;
    }

    const refreshToken = getRefreshToken();

    if (!refreshToken) {
        throw new Error(
            "No 3-legged OAuth token available. Run `npm run auth` once, " +
                "or set APS_REFRESH_TOKEN / pass --token."
        );
    }

    const data = await requestThreeLeggedToken(
        new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        })
    );

    saveTokenCache({
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? refreshToken,
        expires_at: Date.now() + data.expires_in * 1000,
    });

    return data.access_token;
}

export async function tryRefreshThreeLeggedToken(): Promise<
    string | null
> {
    const refreshToken = getRefreshToken();

    if (!refreshToken) {
        return null;
    }

    try {
        return await getThreeLeggedToken();
    } catch {
        return null;
    }
}

export function resolveWorkItemTarget(
    argv: string[] = process.argv.slice(2)
): WorkItemTarget {
    const args = parseCliArgs(argv);

    return {
        hubId: resolveSetting(
            getCliValue(args, "hub"),
            APS_HUB_ID,
            "hub ID (--hub or APS_HUB_ID)"
        ),
        fileURN: resolveSetting(
            getCliValue(args, "file"),
            APS_FILE_URN,
            "file URN (--file or APS_FILE_URN)"
        ),
    };
}

function isTwoLeggedTokenFresh(expiresAt: number): boolean {
    return expiresAt > Date.now() + TWO_LEGGED_EXPIRY_SKEW_MS;
}

async function requestTwoLeggedToken(): Promise<string> {
    requireApsCredentials();

    const credentials = Buffer.from(
        `${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`
    ).toString("base64");

    const response = await fetch(
        "https://developer.api.autodesk.com/authentication/v2/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${credentials}`,
            },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                scope: APS_SCOPES,
            }),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Failed to get APS 2-legged token: ${response.status}\n${text}`
        );
    }

    const data = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
    };

    if (!data.access_token) {
        throw new Error("APS did not return a 2-legged access_token.");
    }

    const expiresInSeconds =
        typeof data.expires_in === "number" && data.expires_in > 0
            ? data.expires_in
            : 3600;

    twoLeggedTokenCache = {
        access_token: data.access_token,
        expires_at: Date.now() + expiresInSeconds * 1000,
    };

    return data.access_token;
}

export async function getTwoLeggedToken(): Promise<string> {
    if (
        twoLeggedTokenCache &&
        isTwoLeggedTokenFresh(twoLeggedTokenCache.expires_at)
    ) {
        return twoLeggedTokenCache.access_token;
    }

    if (twoLeggedTokenInFlight) {
        return twoLeggedTokenInFlight;
    }

    twoLeggedTokenInFlight = requestTwoLeggedToken().finally(() => {
        twoLeggedTokenInFlight = null;
    });

    return twoLeggedTokenInFlight;
}

export async function ensureBucket(
    token: string,
    bucketKey: string
): Promise<void> {
    const response = await fetch(
        `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/details`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (response.ok) {
        return;
    }

    const createResponse = await fetch(
        "https://developer.api.autodesk.com/oss/v2/buckets",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                bucketKey,
                policyKey: "transient",
            }),
        }
    );

    if (!createResponse.ok) {
        const text = await createResponse.text();
        throw new Error(
            `Failed to create OSS bucket ${bucketKey}: ${createResponse.status}\n${text}`
        );
    }
}

export async function getSignedOssDownload(
    token: string,
    bucketKey: string,
    objectKey: string,
    minutesExpiration = 15
): Promise<SignedOssDownload> {
    const signedUrlResponse = await fetch(
        "https://developer.api.autodesk.com/oss/v2/buckets/" +
            `${encodeURIComponent(bucketKey)}/objects/` +
            `${encodeURIComponent(objectKey)}/signeds3download` +
            `?minutesExpiration=${minutesExpiration}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    const signedText = await signedUrlResponse.text();

    if (!signedUrlResponse.ok) {
        throw new Error(
            `Failed to get signed OSS download URL for ${objectKey}: ` +
                `${signedUrlResponse.status}\n${signedText}`
        );
    }

    const signed = JSON.parse(signedText) as SignedOssDownload;

    if (
        !signed.url &&
        (!signed.urls || Object.keys(signed.urls).length === 0)
    ) {
        throw new Error(
            `OSS did not return a signed download URL for ${objectKey} ` +
                `(status: ${signed.status ?? "unknown"})`
        );
    }

    return signed;
}

async function fetchOssByteRange(
    url: string,
    start: number,
    end: number
): Promise<Buffer> {
    const response = await fetch(url, {
        headers: {
            Range: `bytes=${start}-${end}`,
        },
    });

    if (response.status !== 206 && response.status !== 200) {
        const text = await response.text();
        throw new Error(
            `Failed to download OSS byte range ${start}-${end}: ` +
                `${response.status}\n${text}`
        );
    }

    return Buffer.from(await response.arrayBuffer());
}

async function runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;

            if (index >= tasks.length) {
                return;
            }

            results[index] = await tasks[index]();
        }
    }

    const workerCount = Math.min(
        concurrency,
        Math.max(1, tasks.length)
    );

    await Promise.all(
        Array.from({ length: workerCount }, () => worker())
    );

    return results;
}

async function downloadSignedUrlToPath(
    signed: SignedOssDownload,
    destinationPath: string
): Promise<void> {
    if (
        signed.status === "chunked" &&
        signed.urls &&
        Object.keys(signed.urls).length > 0
    ) {
        const chunks = await Promise.all(
            Object.entries(signed.urls).map(async ([range, url]) => {
                const match = /^bytes=(\d+)-(\d+)$/.exec(range);

                if (!match) {
                    throw new Error(
                        `Unexpected OSS chunked download range: ${range}`
                    );
                }

                const start = Number(match[1]);
                const end = Number(match[2]);

                return {
                    start,
                    bytes: await fetchOssByteRange(url, start, end),
                };
            })
        );

        chunks.sort((left, right) => left.start - right.start);

        const totalSize = signed.size ??
            chunks.reduce(
                (sum, chunk) => sum + chunk.bytes.length,
                0
            );

        const fileHandle = openSync(destinationPath, "w");

        try {
            let offset = 0;

            for (const chunk of chunks) {
                writeSync(
                    fileHandle,
                    chunk.bytes,
                    0,
                    chunk.bytes.length,
                    offset
                );
                offset += chunk.bytes.length;
            }

            if (signed.size && offset !== totalSize) {
                throw new Error(
                    `OSS chunked download size mismatch: ` +
                    `expected ${totalSize}, got ${offset}`
                );
            }
        } finally {
            closeSync(fileHandle);
        }

        return;
    }

    const downloadUrl = signed.url;

    if (!downloadUrl) {
        throw new Error(
            "OSS signed download response did not include a URL."
        );
    }

    const objectSize = signed.size;

    if (
        !objectSize ||
        objectSize < OSS_PARALLEL_DOWNLOAD_THRESHOLD
    ) {
        const response = await fetch(downloadUrl);

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to download OSS object from signed URL: ` +
                    `${response.status}\n${text}`
            );
        }

        writeFileSync(
            destinationPath,
            Buffer.from(await response.arrayBuffer())
        );

        return;
    }

    const partCount = Math.ceil(
        objectSize / OSS_DOWNLOAD_PART_SIZE
    );
    const tasks = Array.from(
        { length: partCount },
        (_, index) => {
            const start = index * OSS_DOWNLOAD_PART_SIZE;
            const end = Math.min(
                start + OSS_DOWNLOAD_PART_SIZE - 1,
                objectSize - 1
            );

            return async () => ({
                start,
                bytes: await fetchOssByteRange(
                    downloadUrl,
                    start,
                    end
                ),
            });
        }
    );

    const parts = await runWithConcurrency(
        tasks,
        OSS_DOWNLOAD_CONCURRENCY
    );

    parts.sort((left, right) => left.start - right.start);

    const fileHandle = openSync(destinationPath, "w");

    try {
        let offset = 0;

        for (const part of parts) {
            writeSync(
                fileHandle,
                part.bytes,
                0,
                part.bytes.length,
                offset
            );
            offset += part.bytes.length;
        }

        if (offset !== objectSize) {
            throw new Error(
                `OSS parallel download size mismatch: ` +
                `expected ${objectSize}, got ${offset}`
            );
        }
    } finally {
        closeSync(fileHandle);
    }
}

export async function uploadBucketObject(
    token: string,
    bucketKey: string,
    objectKey: string,
    sourcePath: string
): Promise<void> {
    const bytes = readFileSync(sourcePath);
    const totalParts = Math.max(
        1,
        Math.ceil(bytes.length / OSS_UPLOAD_PART_SIZE)
    );

    let partsUploaded = 0;
    let uploadKey: string | undefined;
    let pendingUploadUrls: string[] = [];

    async function refreshUploadUrls(
        partCount: number
    ): Promise<void> {
        let signedUrl =
            "https://developer.api.autodesk.com/oss/v2/buckets/" +
            `${encodeURIComponent(bucketKey)}/objects/` +
            `${encodeURIComponent(objectKey)}/signeds3upload` +
            `?parts=${partCount}` +
            `&firstPart=${partsUploaded + 1}` +
            "&minutesExpiration=15";

        if (uploadKey) {
            signedUrl +=
                `&uploadKey=${encodeURIComponent(uploadKey)}`;
        }

        const signedUrlResponse = await fetch(signedUrl, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        const signedText = await signedUrlResponse.text();

        if (!signedUrlResponse.ok) {
            throw new Error(
                `Failed to get signed OSS upload URL for ${objectKey}: ` +
                    `${signedUrlResponse.status}\n${signedText}`
            );
        }

        const signed = JSON.parse(signedText) as {
            uploadKey?: string;
            urls?: string[];
        };

        uploadKey = signed.uploadKey;
        pendingUploadUrls = signed.urls ?? [];

        if (!uploadKey || pendingUploadUrls.length === 0) {
            throw new Error(
                `OSS did not return upload URLs for ${objectKey}`
            );
        }
    }

    while (partsUploaded < totalParts) {
        if (pendingUploadUrls.length === 0) {
            const remainingParts = totalParts - partsUploaded;
            const batchSize = Math.min(
                OSS_MAX_UPLOAD_PARTS_PER_REQUEST,
                remainingParts
            );

            await refreshUploadUrls(batchSize);
        }

        const batchTasks: Array<() => Promise<number>> = [];

        while (
            pendingUploadUrls.length > 0 &&
            batchTasks.length < OSS_MAX_UPLOAD_PARTS_PER_REQUEST &&
            partsUploaded + batchTasks.length < totalParts
        ) {
            const uploadUrl = pendingUploadUrls.shift()!;

            const partIndex = partsUploaded + batchTasks.length;
            const start = partIndex * OSS_UPLOAD_PART_SIZE;
            const end = Math.min(
                start + OSS_UPLOAD_PART_SIZE,
                bytes.length
            );
            const chunk = bytes.subarray(start, end);

            batchTasks.push(async () => {
                const uploadResponse = await fetch(uploadUrl, {
                    method: "PUT",
                    body: chunk,
                });

                if (!uploadResponse.ok) {
                    const text = await uploadResponse.text();
                    throw new Error(
                        `Failed to upload OSS object part for ${objectKey}: ` +
                            `${uploadResponse.status}\n${text}`
                    );
                }

                return chunk.length;
            });
        }

        await Promise.all(batchTasks.map((task) => task()));
        partsUploaded += batchTasks.length;
    }

    const completeResponse = await fetch(
        "https://developer.api.autodesk.com/oss/v2/buckets/" +
            `${encodeURIComponent(bucketKey)}/objects/` +
            `${encodeURIComponent(objectKey)}/signeds3upload`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                uploadKey,
            }),
        }
    );

    const completeText = await completeResponse.text();

    if (!completeResponse.ok) {
        throw new Error(
            `Failed to finalize OSS upload for ${objectKey}: ` +
                `${completeResponse.status}\n${completeText}`
        );
    }
}

export async function downloadBucketObject(
    token: string,
    bucketKey: string,
    objectKey: string,
    destinationPath: string
): Promise<void> {
    const signed = await getSignedOssDownload(
        token,
        bucketKey,
        objectKey
    );

    await downloadSignedUrlToPath(signed, destinationPath);
}

/**
 * Deletes one object from an OSS bucket. Requires data:write scope.
 * Best-effort: callers may catch/log failures without failing the export.
 */
export async function deleteBucketObject(
    token: string,
    bucketKey: string,
    objectKey: string
): Promise<void> {
    const url =
        "https://developer.api.autodesk.com/oss/v2/buckets/" +
        `${encodeURIComponent(bucketKey)}/objects/` +
        `${encodeURIComponent(objectKey)}`;

    const response = await fetch(url, {
        method: "DELETE",
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (response.status === 404) {
        return;
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Failed to delete OSS object ${objectKey}: ` +
                `${response.status}\n${text}`
        );
    }
}

/**
 * Deletes OSS objects used by a completed export job.
 * Individual failures are logged but do not throw.
 */
export async function deleteBucketObjects(
    token: string,
    bucketKey: string,
    objectKeys: string[]
): Promise<void> {
    for (const objectKey of objectKeys) {
        try {
            await deleteBucketObject(
                token,
                bucketKey,
                objectKey
            );

            console.log(`Deleted OSS object: ${objectKey}`);
        } catch (error) {
            console.warn(
                `Could not delete OSS object ${objectKey}: ${error}`
            );
        }
    }
}

export async function upsertAlias(
    token: string,
    resourceKind: "activities" | "appbundles",
    resourceId: string,
    aliasId: string,
    version: number
): Promise<void> {
    const baseUrl =
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/${resourceKind}/${resourceId}/aliases`;

    const payload = {
        id: aliasId,
        version,
    };

    const createResponse = await fetch(baseUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });

    if (createResponse.ok) {
        return;
    }

    const createText = await createResponse.text();

    if (createResponse.status !== 409) {
        throw new Error(
            `Failed to create ${resourceKind} alias: ${createResponse.status}\n${createText}`
        );
    }

    const patchResponse = await fetch(`${baseUrl}/${aliasId}`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ version }),
    });

    const patchText = await patchResponse.text();

    if (!patchResponse.ok) {
        throw new Error(
            `Failed to update ${resourceKind} alias: ${patchResponse.status}\n${patchText}`
        );
    }
}
