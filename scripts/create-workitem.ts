import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
    APS_BUCKET_KEY,
    buildOssObjectUrn,
    ensureBucket,
    inferInputFormat,
    resolveWorkItemTarget,
} from "./aps-common";
import { getCliValue, hasCliFlag, parseCliArgs } from "./cli-args";
import {
    cleanupExportJobOss,
    createWorkItem,
    downloadExportZip,
    fetchWorkItemReport,
    getThreeLeggedTokenForExport,
    getTwoLeggedTokenForExport,
    interpretWorkItemFailure,
    uploadOssInputFromPath,
    waitForWorkItem,
} from "./export-service";

async function resolveWorkItemInput(
    args: Map<string, string | true>,
    token: string
) {
    const inputPath = getCliValue(args, "input");
    const existingObjectKey = getCliValue(args, "oss-key");

    if (inputPath || existingObjectKey) {
        if (!APS_BUCKET_KEY) {
            throw new Error(
                "OSS input requires APS_BUCKET_KEY in .env."
            );
        }

        if (inputPath) {
            const ossInput = await uploadOssInputFromPath(
                token,
                inputPath
            );

            return {
                mode: "oss" as const,
                ...ossInput,
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
            mode: "oss" as const,
            inputObjectKey: existingObjectKey!,
            inputFormat,
        };
    }

    const target = resolveWorkItemTarget();

    return {
        mode: "hub" as const,
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

    const token = await getTwoLeggedTokenForExport();

    if (APS_BUCKET_KEY) {
        console.log(`Ensuring OSS bucket ${APS_BUCKET_KEY} exists...`);
        await ensureBucket(token, APS_BUCKET_KEY);
    }

    const input = await resolveWorkItemInput(args, token);

    const threeLeggedToken = usesOssInput
        ? undefined
        : await getThreeLeggedTokenForExport(getCliValue(args, "token"));

    const outputObjectKey = `exports/${randomUUID()}.zip`;

    console.log("Submitting WorkItem...");

    const workItem = await createWorkItem(
        token,
        input,
        outputObjectKey,
        threeLeggedToken
    );

    if (!workItem.id) {
        throw new Error("APS did not return a WorkItem ID.");
    }

    const finalStatus = await waitForWorkItem(token, workItem.id);

    console.log("\n================================");
    console.log("WorkItem finished");
    console.log("================================");

    console.log("ID:", finalStatus.id);
    console.log("Status:", finalStatus.status);

    let report: string | null = null;

    if (finalStatus.reportUrl) {
        console.log("Report URL:", finalStatus.reportUrl);

        report = await fetchWorkItemReport(finalStatus.reportUrl);

        if (report) {
            console.log("\nWorkItem report:\n");
            console.log(report);
        }
    }

    if (finalStatus.status !== "success") {
        throw new Error(
            interpretWorkItemFailure(
                finalStatus.status ?? "unknown",
                report
            )
        );
    }

    if (APS_BUCKET_KEY) {
        const outputPath = join(
            resolve(import.meta.dirname, ".."),
            "output",
            `${workItem.id}.zip`
        );

        console.log("\nDownloading exported STEP zip from OSS...");

        mkdirSync(dirname(outputPath), { recursive: true });

        await downloadExportZip(outputObjectKey, outputPath);

        console.log("Saved:", outputPath);

        if (!hasCliFlag(args, "keep-oss")) {
            await cleanupExportJobOss({
                jobId: randomUUID(),
                workItemId: workItem.id!,
                inputObjectKey:
                    input.mode === "oss" ? input.inputObjectKey : "",
                outputObjectKey,
                inputFormat:
                    input.mode === "oss" ? input.inputFormat : "step",
                status: "success",
                createdAt: Date.now(),
            });

            console.log("\nCleaned up OSS objects.");
        } else {
            console.log("\nSkipping OSS cleanup (--keep-oss).");
        }
    }

    console.log("\nWorkItem completed successfully.");
}

main().catch((error) => {
    console.error("\nWorkItem execution failed:");
    console.error(error);

    process.exit(1);
});
