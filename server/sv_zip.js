/**
 * Zero-dependency ZIP file reader and unpacker for Node.js
 * Uses Node's built-in zlib module to decompress Deflate (method 8) and Stored (method 0) files.
 * Works seamlessly in FXServer Node.js runtime and standalone Node.js environments.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class ZipExtractor {
    /**
     * Parse a zip buffer and return a list of extracted file entries.
     * @param {Buffer} buffer 
     * @param {Object} options 
     * @returns {Array<{ path: string, isDirectory: boolean, data: Buffer }>}
     */
    static parse(buffer, options = {}) {
        const stripRoot = options.stripRoot !== false; // Default true (strips github's 'repo-commit/' root)
        const subfolder = (options.subfolder || '').replace(/^[\\/]+|[\\/]+$/g, '').toLowerCase();

        // 1. Find End of Central Directory Record (EOCD)
        // EOCD signature is 0x06054b50 ("PK\x05\x06")
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
                // Not a central directory header
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

        // Determine if there is a common top-level root folder (like GitHub's "repo-name-commit/")
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

            // Check subfolder filtering if specified
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

            // Extract file content from local header
            if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
                throw new Error(`Invalid local header signature for file: ${entry.filename}`);
            }

            const localFilenameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
            const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
            const dataOffset = entry.localHeaderOffset + 30 + localFilenameLength + localExtraLength;

            const compressedData = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
            let uncompressedData;

            if (entry.method === 0) {
                // Stored (no compression)
                uncompressedData = Buffer.from(compressedData);
            } else if (entry.method === 8) {
                // Deflated
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

    /**
     * Extract zip buffer directly to target directory on disk
     * @param {Buffer} buffer 
     * @param {string} destinationDir 
     * @param {Object} options 
     */
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
