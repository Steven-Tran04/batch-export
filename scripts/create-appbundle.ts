import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
    APPBUNDLE_ALIAS,
    APPBUNDLE_ID,
    APS_REGION,
    getQualifiedAppBundleId,
    getTwoLeggedToken,
    upsertAlias,
} from "./aps-common";
import { writeZipArchive } from "./zip-store";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE_FOLDER = "BatchExportAppBundle";
const SCRIPT_SOURCE = "batch-export.ts";
const SCRIPT_ENTRY = "Contents/main.ts";
const PACKAGE_CONTENTS = "PackageContents.xml";

function createBundleZip(zipPath: string): void {
    const scriptSourcePath = join(ROOT, SCRIPT_SOURCE);
    const packageContentsPath = join(ROOT, BUNDLE_FOLDER, PACKAGE_CONTENTS);

    if (!existsSync(scriptSourcePath)) {
        throw new Error(`Missing required script file: ${SCRIPT_SOURCE}`);
    }

    if (!existsSync(packageContentsPath)) {
        throw new Error(
            `Missing required bundle file: ${BUNDLE_FOLDER}/${PACKAGE_CONTENTS}`
        );
    }

    writeZipArchive(zipPath, [
        {
            archivePath: `${BUNDLE_FOLDER}/${PACKAGE_CONTENTS}`,
            sourcePath: packageContentsPath,
        },
        {
            archivePath: `${BUNDLE_FOLDER}/${SCRIPT_ENTRY}`,
            sourcePath: scriptSourcePath,
        },
    ]);
}

async function registerAppBundle(token: string) {
    const response = await fetch(
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/appbundles`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                id: APPBUNDLE_ID,
                engine: "Autodesk.Fusion+Latest",
                description:
                    "Batch export Fusion assembly components to STEP files.",
            }),
        }
    );

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to register AppBundle: ${response.status}\n${text}`
        );
    }

    return JSON.parse(text);
}

async function createAppBundleVersion(token: string) {
    const response = await fetch(
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/appbundles/${APPBUNDLE_ID}/versions`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                engine: "Autodesk.Fusion+Latest",
                description:
                    "Batch export Fusion assembly components to STEP files.",
            }),
        }
    );

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to create AppBundle version: ${response.status}\n${text}`
        );
    }

    return JSON.parse(text);
}

async function uploadBundleZip(
    uploadParameters: {
        endpointURL: string;
        formData: Record<string, string>;
    },
    zipPath: string
): Promise<void> {
    const formData = new FormData();

    for (const [key, value] of Object.entries(uploadParameters.formData)) {
        formData.append(key, value);
    }

    const zipBytes = readFileSync(zipPath);
    const blob = new Blob([zipBytes], {
        type: "application/octet-stream",
    });

    formData.append("file", blob, basename(zipPath));

    const response = await fetch(uploadParameters.endpointURL, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Failed to upload AppBundle zip: ${response.status}\n${text}`
        );
    }
}

async function main(): Promise<void> {
    const zipPath = join(ROOT, `${BUNDLE_FOLDER}.zip`);

    console.log("Creating AppBundle zip...");
    createBundleZip(zipPath);
    console.log(`Created ${zipPath}`);
    console.log(
        "Bundle layout:",
        `${BUNDLE_FOLDER}/${PACKAGE_CONTENTS},`,
        `${BUNDLE_FOLDER}/${SCRIPT_ENTRY}`
    );

    console.log("Getting APS access token...");
    const token = await getTwoLeggedToken();

    let bundle;

    try {
        console.log("Registering AppBundle...");
        bundle = await registerAppBundle(token);
    } catch (error) {
        const message = String(error);

        if (!message.includes("409")) {
            throw error;
        }

        console.log("AppBundle already exists. Creating a new version...");
        bundle = await createAppBundleVersion(token);
    }

    console.log(
        `Uploading AppBundle version ${bundle.version}...`
    );

    await uploadBundleZip(bundle.uploadParameters, zipPath);

    console.log("Creating AppBundle alias...");
    await upsertAlias(
        token,
        "appbundles",
        APPBUNDLE_ID,
        APPBUNDLE_ALIAS,
        bundle.version
    );
    console.log("AppBundle alias updated successfully.");

    console.log(
        `\nAppBundle is available as ${getQualifiedAppBundleId()}`
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
