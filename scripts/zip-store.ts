import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Writes a minimal ZIP archive using the STORE method (no compression).
 */
export function writeZipArchive(
    zipPath: string,
    files: Array<{ archivePath: string; sourcePath: string }>
): void {
    const chunks: number[] = [];
    const centralDirectory: number[] = [];
    let offset = 0;

    function writeUint16(target: number[], value: number): void {
        target.push(value & 0xff, (value >> 8) & 0xff);
    }

    function writeUint32(target: number[], value: number): void {
        target.push(
            value & 0xff,
            (value >> 8) & 0xff,
            (value >> 16) & 0xff,
            (value >> 24) & 0xff
        );
    }

    function crc32(bytes: Uint8Array): number {
        let crc = 0xffffffff;

        for (let i = 0; i < bytes.length; i++) {
            crc ^= bytes[i];

            for (let bit = 0; bit < 8; bit++) {
                const mask = -(crc & 1);
                crc = (crc >>> 1) ^ (0xedb88320 & mask);
            }
        }

        return (crc ^ 0xffffffff) >>> 0;
    }

    for (const file of files) {
        const fileName = file.archivePath.replace(/\\/g, "/");
        const fileBytes = new Uint8Array(readFileSync(file.sourcePath));
        const localHeaderStart = offset;
        const fileCrc = crc32(fileBytes);

        writeUint32(chunks, 0x04034b50);
        writeUint16(chunks, 20);
        writeUint16(chunks, 0);
        writeUint16(chunks, 0);
        writeUint16(chunks, 0);
        writeUint16(chunks, 0);
        writeUint32(chunks, fileCrc);
        writeUint32(chunks, fileBytes.length);
        writeUint32(chunks, fileBytes.length);
        writeUint16(chunks, fileName.length);
        writeUint16(chunks, 0);

        for (let i = 0; i < fileName.length; i++) {
            chunks.push(fileName.charCodeAt(i));
        }

        for (let i = 0; i < fileBytes.length; i++) {
            chunks.push(fileBytes[i]);
        }

        offset = chunks.length;

        writeUint32(centralDirectory, 0x02014b50);
        writeUint16(centralDirectory, 20);
        writeUint16(centralDirectory, 20);
        writeUint16(centralDirectory, 0);
        writeUint16(centralDirectory, 0);
        writeUint16(centralDirectory, 0);
        writeUint16(centralDirectory, 0);
        writeUint32(centralDirectory, fileCrc);
        writeUint32(centralDirectory, fileBytes.length);
        writeUint32(centralDirectory, fileBytes.length);
        writeUint16(centralDirectory, fileName.length);
        writeUint16(centralDirectory, 0);
        writeUint16(centralDirectory, 0);
        writeUint16(centralDirectory, 0);
        writeUint16(centralDirectory, 0);
        writeUint32(centralDirectory, 0);
        writeUint32(centralDirectory, localHeaderStart);

        for (let i = 0; i < fileName.length; i++) {
            centralDirectory.push(fileName.charCodeAt(i));
        }
    }

    const centralDirectoryStart = chunks.length;
    chunks.push(...centralDirectory);

    writeUint32(chunks, 0x06054b50);
    writeUint16(chunks, 0);
    writeUint16(chunks, 0);
    writeUint16(chunks, files.length);
    writeUint16(chunks, files.length);
    writeUint32(chunks, centralDirectory.length);
    writeUint32(chunks, centralDirectoryStart);
    writeUint16(chunks, 0);

    writeFileSync(zipPath, new Uint8Array(chunks));
}

export function archiveBaseName(filePath: string): string {
    return (
        filePath.split("/").pop() ||
        filePath.split("\\").pop() ||
        filePath
    );
}

export function zipFilesByBasename(
    zipPath: string,
    filePaths: string[]
): void {
    writeZipArchive(
        zipPath,
        filePaths.map((sourcePath) => ({
            archivePath: archiveBaseName(sourcePath),
            sourcePath,
        }))
    );
}
