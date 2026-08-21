import {
    ACTIVITY_ALIAS,
    ACTIVITY_ID,
    APPBUNDLE_ALIAS,
    APPBUNDLE_ID,
    APS_REGION,
    getQualifiedActivityId,
    getQualifiedAppBundleId,
    getTwoLeggedToken,
    upsertAlias,
} from "./aps-common";
function buildActivityPayload() {
    return {
        id: ACTIVITY_ID,
        engine: "Autodesk.Fusion+Latest",
        commandline: [],
        parameters: {
            TaskParameters: {
                verb: "read",
                description:
                    "JSON parameters passed to the Fusion batch export script.",
                required: true,
            },
            InputF3d: {
                verb: "get",
                description: "Native Fusion archive input (.f3d).",
                required: false,
                localName: "input.f3d",
            },
            InputStep: {
                verb: "get",
                description: "STEP input (.step/.stp).",
                required: false,
                localName: "input.stp",
            },
            OutputZip: {
                verb: "put",
                description:
                    "Zip archive containing exported STEP files.",
                required: false,
                localName: "exports.zip",
            },
        },
        appbundles: [
            getQualifiedAppBundleId(),
        ],
        settings: {},
        description:
            "Exports the components of a Fusion assembly as STEP files.",
    };
}

async function createActivity(token: string) {
    const url =
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/activities`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(buildActivityPayload()),
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to create Activity: ${response.status}\n${text}`
        );
    }

    console.log("Activity created successfully.");
    console.log(text);

    return JSON.parse(text);
}

async function createActivityVersion(token: string) {
    const url =
        `https://developer.api.autodesk.com/da/${APS_REGION}/v3/activities/${ACTIVITY_ID}/versions`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            engine: "Autodesk.Fusion+Latest",
            commandline: [],
            parameters: buildActivityPayload().parameters,
            appbundles: buildActivityPayload().appbundles,
            settings: {},
            description:
                "Exports the components of a Fusion assembly as STEP files.",
        }),
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Failed to create Activity version: ${response.status}\n${text}`
        );
    }

    console.log("Activity version created successfully.");
    console.log(text);

    return JSON.parse(text);
}

async function main() {
    console.log("Getting APS access token...");

    const token = await getTwoLeggedToken();

    console.log("Creating Activity...");

    let activity;

    try {
        activity = await createActivity(token);
    } catch (error) {
        const message = String(error);

        if (!message.includes("409")) {
            throw error;
        }

        console.log("Activity already exists. Creating a new version...");
        activity = await createActivityVersion(token);
    }

    console.log(
        `Created ${activity.id}, version ${activity.version}`
    );

    console.log("Creating Activity alias...");

    await upsertAlias(
        token,
        "activities",
        ACTIVITY_ID,
        ACTIVITY_ALIAS,
        activity.version
    );

    console.log("Activity alias updated successfully.");

    console.log(
        `Activity is available as ${getQualifiedActivityId()}`
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
