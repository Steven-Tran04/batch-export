import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME ?? "batch-export";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const ROLE_NAME = `${FUNCTION_NAME}-lambda-role`;

const AWS_CLI =
    process.platform === "win32"
        ? "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe"
        : "aws";

function run(
    command: string,
    args: string[],
    options?: { allowFailure?: boolean }
): string {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
    });

    if (result.status !== 0 && !options?.allowFailure) {
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        throw new Error(
            `${command} ${args.join(" ")} failed:\n${output}`
        );
    }

    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function aws(args: string[], options?: { allowFailure?: boolean }): string {
    return run(AWS_CLI, ["--region", REGION, ...args], options);
}

function fileArg(path: string, binary = false): string {
    const normalized = path.replace(/\\/g, "/");
    return `${binary ? "fileb" : "file"}://${normalized}`;
}

function loadDotEnv(): Record<string, string> {
    const envPath = resolve(ROOT, ".env");
    const values: Record<string, string> = {};

    if (!existsSync(envPath)) {
        return values;
    }

    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        const separator = trimmed.indexOf("=");

        if (separator <= 0) {
            continue;
        }

        values[trimmed.slice(0, separator)] = trimmed
            .slice(separator + 1)
            .replace(/^['"]|['"]$/g, "");
    }

    return values;
}

function requiredEnv(
    env: Record<string, string>,
    key: string
): string {
    const value = process.env[key] ?? env[key];

    if (!value) {
        throw new Error(`${key} is missing. Set it in .env or the environment.`);
    }

    return value;
}

const identity = aws(["sts", "get-caller-identity", "--output", "json"]);
const account = JSON.parse(identity) as { Account: string };
const env = loadDotEnv();

const variables = {
    APS_CLIENT_ID: requiredEnv(env, "APS_CLIENT_ID"),
    APS_CLIENT_SECRET: requiredEnv(env, "APS_CLIENT_SECRET"),
    APS_NICKNAME: requiredEnv(env, "APS_NICKNAME"),
    APS_BUCKET_KEY: env.APS_BUCKET_KEY ?? "batch-export-output",
    APS_REGION: env.APS_REGION ?? "us-east",
};

mkdirSync(resolve(ROOT, "dist/lambda"), { recursive: true });
const esbuildBin =
    process.platform === "win32"
        ? join(ROOT, "node_modules", "esbuild", "bin", "esbuild")
        : join(ROOT, "node_modules", ".bin", "esbuild");
run(process.execPath, [
    esbuildBin,
    resolve(ROOT, "scripts/lambda-handler.ts"),
    "--bundle",
    "--platform=node",
    "--target=node20",
    "--format=cjs",
    `--outfile=${resolve(ROOT, "dist/lambda/index.js")}`,
]);

const zipPath = resolve(ROOT, "dist/function.zip");
run("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Force -Path '${resolve(ROOT, "dist/lambda/index.js")}' -DestinationPath '${zipPath}'`,
]);

const staging = join(tmpdir(), "batch-export-lambda");
mkdirSync(staging, { recursive: true });
const stagedZip = join(staging, "function.zip");
copyFileSync(zipPath, stagedZip);

const trustPolicy = {
    Version: "2012-10-17",
    Statement: [
        {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
        },
    ],
};

const envFile = join(staging, "environment.json");
writeFileSync(
    envFile,
    JSON.stringify({ Variables: variables }),
    "utf8"
);

const trustFile = join(staging, "trust-policy.json");
writeFileSync(trustFile, JSON.stringify(trustPolicy), "utf8");

const roleLookup = aws(
    ["iam", "get-role", "--role-name", ROLE_NAME, "--output", "json"],
    { allowFailure: true }
);

let roleArn: string;

if (roleLookup.includes("NoSuchEntity") || !roleLookup.includes("Arn")) {
    const created = aws([
        "iam",
        "create-role",
        "--role-name",
        ROLE_NAME,
        "--assume-role-policy-document",
        fileArg(trustFile),
        "--output",
        "json",
    ]);
    roleArn = (JSON.parse(created) as { Role: { Arn: string } }).Role.Arn;
    aws([
        "iam",
        "attach-role-policy",
        "--role-name",
        ROLE_NAME,
        "--policy-arn",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ]);
    console.log("Waiting for IAM role to propagate...");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
} else {
    roleArn = (JSON.parse(roleLookup) as { Role: { Arn: string } }).Role.Arn;
}

const existing = aws(
    [
        "lambda",
        "get-function",
        "--function-name",
        FUNCTION_NAME,
        "--output",
        "json",
    ],
    { allowFailure: true }
);

if (existing.includes("FunctionName")) {
    aws([
        "lambda",
        "update-function-code",
        "--function-name",
        FUNCTION_NAME,
        "--zip-file",
        fileArg(stagedZip, true),
    ]);
    aws([
        "lambda",
        "wait",
        "function-updated-v2",
        "--function-name",
        FUNCTION_NAME,
    ]);
    aws([
        "lambda",
        "update-function-configuration",
        "--function-name",
        FUNCTION_NAME,
        "--timeout",
        "29",
        "--memory-size",
        "512",
        "--environment",
        fileArg(envFile),
    ]);
} else {
    aws([
        "lambda",
        "create-function",
        "--function-name",
        FUNCTION_NAME,
        "--runtime",
        "nodejs20.x",
        "--architectures",
        "arm64",
        "--handler",
        "index.handler",
        "--role",
        roleArn,
        "--zip-file",
        fileArg(stagedZip, true),
        "--timeout",
        "29",
        "--memory-size",
        "512",
        "--environment",
        fileArg(envFile),
    ]);
    aws([
        "lambda",
        "wait",
        "function-active-v2",
        "--function-name",
        FUNCTION_NAME,
    ]);
}

const corsFile = join(staging, "cors.json");
writeFileSync(
    corsFile,
    JSON.stringify({
        AllowOrigins: ["*"],
        AllowMethods: ["GET", "POST"],
        AllowHeaders: ["content-type"],
        AllowCredentials: false,
    }),
    "utf8"
);

const urlConfig = aws(
    [
        "lambda",
        "get-function-url-config",
        "--function-name",
        FUNCTION_NAME,
        "--output",
        "json",
    ],
    { allowFailure: true }
);

if (!/"FunctionUrl"\s*:/.test(urlConfig)) {
    aws([
        "lambda",
        "create-function-url-config",
        "--function-name",
        FUNCTION_NAME,
        "--auth-type",
        "NONE",
        "--cors",
        fileArg(corsFile),
    ]);
    aws(
        [
            "lambda",
            "add-permission",
            "--function-name",
            FUNCTION_NAME,
            "--statement-id",
            "FunctionURLAllowPublicAccess",
            "--action",
            "lambda:InvokeFunctionUrl",
            "--principal",
            "*",
            "--function-url-auth-type",
            "NONE",
        ],
        { allowFailure: true }
    );
    aws(
        [
            "lambda",
            "add-permission",
            "--function-name",
            FUNCTION_NAME,
            "--statement-id",
            "FunctionURLInvokeAllowPublicAccess",
            "--action",
            "lambda:InvokeFunction",
            "--principal",
            "*",
            "--invoked-via-function-url",
        ],
        { allowFailure: true }
    );
}

aws(
    [
        "lambda",
        "add-permission",
        "--function-name",
        FUNCTION_NAME,
        "--statement-id",
        "FunctionURLInvokeAllowPublicAccess",
        "--action",
        "lambda:InvokeFunction",
        "--principal",
        "*",
        "--invoked-via-function-url",
    ],
    { allowFailure: true }
);

const urlInfo = JSON.parse(
    aws([
        "lambda",
        "get-function-url-config",
        "--function-name",
        FUNCTION_NAME,
        "--output",
        "json",
    ])
) as { FunctionUrl: string };

writeFileSync(
    resolve(ROOT, "dist/lambda-url.txt"),
    `${urlInfo.FunctionUrl}\n`,
    "utf8"
);

console.log(`Account: ${account.Account}`);
console.log(`Function: ${FUNCTION_NAME}`);
console.log(`URL: ${urlInfo.FunctionUrl}`);
console.log("GET that URL to confirm the health check.");
