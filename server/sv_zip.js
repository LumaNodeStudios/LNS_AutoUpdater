const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class ZipExtractor {
    static parse(buffer, options = {}) {
        const stripRoot = options.stripRoot !== false;
        const subfolder = (options.subfolder || '').replace(/^[\\/]+|[\\/]+$/g, '').toLowerCase();

        let eocdOffset = -1;
        for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
            if (buffer.readUInt32LE(i) === 0x06054b50) {
                eocdOffset = i;
                break;
            }
        }

        if (eocdOffset === -1) {
            throw new Error('Invalid ZIP file: End of Central Directory record not found');
        }

        const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
        const cdSize = buffer.readUInt32LE(eocdOffset + 12);
        const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

        let currentCdOffset = cdOffset;
        const rawEntries = [];

        for (let i = 0; i < totalEntries; i++) {
            if (buffer.readUInt32LE(currentCdOffset) !== 0x02014b50) {
                break;
            }

            const method = buffer.readUInt16LE(currentCdOffset + 10);
            const compressedSize = buffer.readUInt32LE(currentCdOffset + 20);
            const uncompressedSize = buffer.readUInt32LE(currentCdOffset + 24);
            const filenameLength = buffer.readUInt16LE(currentCdOffset + 28);
            const extraLength = buffer.readUInt16LE(currentCdOffset + 30);
            const commentLength = buffer.readUInt16LE(currentCdOffset + 32);
            const localHeaderOffset = buffer.readUInt32LE(currentCdOffset + 42);

            const filenameBytes = buffer.subarray(currentCdOffset + 46, currentCdOffset + 46 + filenameLength);
            let filename = filenameBytes.toString('utf8').replace(/\\/g, '/');

            currentCdOffset += 46 + filenameLength + extraLength + commentLength;

            rawEntries.push({
                filename,
                method,
                compressedSize,
                uncompressedSize,
                localHeaderOffset,
                isDirectory: filename.endsWith('/')
            });
        }

        let commonRoot = '';
        if (stripRoot && rawEntries.length > 0) {
            const firstSlashIndex = rawEntries[0].filename.indexOf('/');
            if (firstSlashIndex !== -1) {
                const potentialRoot = rawEntries[0].filename.substring(0, firstSlashIndex + 1);
                const allShareRoot = rawEntries.every(e => e.filename.startsWith(potentialRoot));
                if (allShareRoot) {
                    commonRoot = potentialRoot;
                }
            }
        }

        const extractedFiles = [];

        for (const entry of rawEntries) {
            let relativePath = entry.filename;
            if (commonRoot && relativePath.startsWith(commonRoot)) {
                relativePath = relativePath.substring(commonRoot.length);
            }

            if (!relativePath || relativePath === '/') continue;

            if (subfolder) {
                const lowerRel = relativePath.toLowerCase();
                if (!lowerRel.startsWith(subfolder + '/') && lowerRel !== subfolder) {
                    continue;
                }
                relativePath = relativePath.substring(subfolder.length).replace(/^[\\/]+/, '');
                if (!relativePath) continue;
            }

            if (entry.isDirectory) {
                extractedFiles.push({
                    path: relativePath.replace(/\/$/, ''),
                    isDirectory: true,
                    data: Buffer.alloc(0)
                });
                continue;
            }

            if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
                throw new Error(`Invalid local header signature for file: ${entry.filename}`);
            }

            const localFilenameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
            const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
            const dataOffset = entry.localHeaderOffset + 30 + localFilenameLength + localExtraLength;

            const compressedData = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
            let uncompressedData;

            if (entry.method === 0) {
                uncompressedData = Buffer.from(compressedData);
            } else if (entry.method === 8) {
                uncompressedData = zlib.inflateRawSync(compressedData);
            } else {
                console.warn(`[AutoUpdater:Zip] Unsupported compression method (${entry.method}) for file: ${entry.filename}`);
                continue;
            }

            extractedFiles.push({
                path: relativePath,
                isDirectory: false,
                data: uncompressedData
            });
        }

        return extractedFiles;
    }

    static extractToDir(buffer, destinationDir, options = {}) {
        const files = this.parse(buffer, options);
        for (const file of files) {
            const fullPath = path.join(destinationDir, file.path);
            if (file.isDirectory) {
                if (!fs.existsSync(fullPath)) {
                    fs.mkdirSync(fullPath, { recursive: true });
                }
            } else {
                const parentDir = path.dirname(fullPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }
                fs.writeFileSync(fullPath, file.data);
            }
        }
        return files;
    }
}

module.exports = ZipExtractor;
