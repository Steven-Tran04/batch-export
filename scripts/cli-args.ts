export function parseCliArgs(
    argv: string[]
): Map<string, string | true> {
    const args = new Map<string, string | true>();

    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];

        if (!value.startsWith("--")) {
            continue;
        }

        const key = value.slice(2);
        const next = argv[index + 1];

        if (!next || next.startsWith("--")) {
            args.set(key, true);
            continue;
        }

        args.set(key, next);
        index += 1;
    }

    return args;
}

export function getCliValue(
    args: Map<string, string | true>,
    name: string
): string | undefined {
    const value = args.get(name);

    if (typeof value === "string") {
        return value;
    }

    return undefined;
}

export function hasCliFlag(
    args: Map<string, string | true>,
    name: string
): boolean {
    return args.get(name) === true;
}

export function resolveSetting(
    cliValue: string | undefined,
    envValue: string | undefined,
    label: string
): string {
    const resolved = cliValue ?? envValue;

    if (!resolved) {
        throw new Error(
            `Missing ${label}. Set it in .env or pass a CLI override.`
        );
    }

    return resolved;
}
