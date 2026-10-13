const fs = require('fs');
const path = require('path');

class ConfigMerger {
    static merge(filePath, localContent, upstreamContent) {
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.json') {
            return this.mergeJson(localContent, upstreamContent);
        } else if (ext === '.lua') {
            return this.mergeLua(localContent, upstreamContent);
        }

        return {
            mergedContent: upstreamContent,
            stats: { preserved: 0, added: 0, addedKeys: [] }
        };
    }

    static parseLuaTable(str) {
        const openIdx = str.indexOf('{');
        const closeIdx = str.lastIndexOf('}');
        if (openIdx === -1 || closeIdx === -1) return null;

        const inner = str.substring(openIdx + 1, closeIdx);
        const lines = inner.split(/\r?\n/);
        const entries = new Map();

        let currentComments = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('--')) {
                currentComments.push(line);
                i++;
                continue;
            }

            if (trimmed === '') {
                if (currentComments.length > 5) currentComments = [];
                i++;
                continue;
            }

            const match = trimmed.match(/^(?:\[['"]([^'"]+)['"]\]|([a-zA-Z0-9_]+))\s*=\s*(.*)$/);
            if (match) {
                const key = match[1] || match[2];
                let valueRest = match[3];

                let rawLines = [line];
                let isTable = valueRest.trim().startsWith('{');
                let braceCount = 0;
                let bracketCount = 0;

                for (const ch of valueRest) {
                    if (ch === '{') braceCount++;
                    if (ch === '}') braceCount--;
                    if (ch === '[') bracketCount++;
                    if (ch === ']') bracketCount--;
                }

                let endIdx = i;
                while (braceCount > 0 && endIdx + 1 < lines.length) {
                    endIdx++;
                    const nextLine = lines[endIdx];
                    rawLines.push(nextLine);
                    for (const ch of nextLine) {
                        if (ch === '{') braceCount++;
                        if (ch === '}') braceCount--;
                    }
                }

                const rawText = rawLines.join('\n');
                const block = [...currentComments, rawText].join('\n');

                let subTable = null;
                if (isTable) {
                    const subOpen = rawText.indexOf('{');
                    subTable = this.parseLuaTable(rawText.substring(subOpen));
                }

                entries.set(key, {
                    key,
                    rawText,
                    block,
                    isTable,
                    subTable,
                    comments: currentComments.slice()
                });

                i = endIdx + 1;
                currentComments = [];
                continue;
            }

            currentComments = [];
            i++;
        }

        return { entries, openIdx, closeIdx };
    }

    static findTableClosePosition(content, tableKeyPath) {
        if (!tableKeyPath) return content.lastIndexOf('}');

        const keys = tableKeyPath.split('.');
        let searchStart = 0;

        for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            const sub = content.substring(searchStart);
            const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`(?:\\[['"]${escapedKey}['"]\\]|\\b${escapedKey}\\b)\\s*=\\s*\\{`);
            const match = pattern.exec(sub);
            if (!match) return -1;

            const tableOpenIdx = searchStart + match.index + match[0].length;
            let braceCount = 1;
            let closeIdx = -1;

            for (let i = tableOpenIdx; i < content.length; i++) {
                const c = content[i];
                if (c === '{') braceCount++;
                else if (c === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        closeIdx = i;
                        break;
                    }
                }
            }

            if (closeIdx === -1) return -1;

            if (k === keys.length - 1) {
                return closeIdx;
            } else {
                searchStart = tableOpenIdx;
            }
        }

        return -1;
    }

    static injectEntriesIntoTable(content, tableKeyPath, entriesToInject, indentLevel = 1) {
        const closePos = this.findTableClosePosition(content, tableKeyPath);
        if (closePos === -1) return content;

        let before = content.substring(0, closePos).trimEnd();
        if (!before.endsWith(',') && !before.endsWith('{')) {
            before += ',';
        }

        const indent = '    '.repeat(indentLevel);
        const formattedBlocks = entriesToInject.map(e => {
            const block = e.block || `${e.key} = ${e.rawText}`;
            const lines = block.split(/\r?\n/);
            return lines.map(line => {
                if (line.trim() === '') return '';
                return line.startsWith(indent) ? line : indent + line.trim();
            }).join('\n') + (block.trim().endsWith(',') ? '' : ',');
        }).join('\n\n');

        const after = content.substring(closePos);
        const commentNotice = tableKeyPath
            ? `${indent}-- [AutoUpdater] New settings added to ${tableKeyPath}:`
            : `${indent}-- [AutoUpdater] New settings added from update:`;

        return before + '\n\n' + commentNotice + '\n' + formattedBlocks + '\n' + '    '.repeat(Math.max(0, indentLevel - 1)) + after;
    }

    static mergeLuaReturnTable(localCode, upstreamCode) {
        const stats = { preserved: 0, added: 0, addedKeys: [] };

        const localParsed = this.parseLuaTable(localCode);
        const upstreamParsed = this.parseLuaTable(upstreamCode);

        if (!localParsed || !upstreamParsed) {
            return { mergedContent: localCode, stats };
        }

        let merged = localCode;

        const processMerge = (locParsed, upParsed, pathPrefix = '', indent = 1) => {
            const toInject = [];

            for (const [key, upEntry] of upParsed.entries.entries()) {
                const currentPath = pathPrefix ? `${pathPrefix}.${key}` : key;
                if (locParsed.entries.has(key)) {
                    stats.preserved++;
                    const locEntry = locParsed.entries.get(key);
                    if (upEntry.isTable && locEntry.isTable && upEntry.subTable && locEntry.subTable) {
                        processMerge(locEntry.subTable, upEntry.subTable, currentPath, indent + 1);
                    }
                } else {
                    stats.added++;
                    stats.addedKeys.push(currentPath);
                    toInject.push(upEntry);
                }
            }

            if (toInject.length > 0) {
                merged = this.injectEntriesIntoTable(merged, pathPrefix, toInject, indent);
            }
        };

        processMerge(localParsed, upstreamParsed);
        return { mergedContent: merged, stats };
    }

    static mergeLua(localContent, upstreamContent) {
        const isReturnTable = /^\s*(?:local\s+)?return\s*\{/m.test(localContent) ||
                              /^\s*(?:local\s+)?return\s*\{/m.test(upstreamContent) ||
                              /^\s*(?:Config|Settings|SETTINGS)\s*=\s*\{/m.test(localContent);

        if (isReturnTable) {
            const tableMergeResult = this.mergeLuaReturnTable(localContent, upstreamContent);
            if (tableMergeResult.stats.preserved > 0 || tableMergeResult.stats.added > 0) {
                return tableMergeResult;
            }
        }

        const stats = { preserved: 0, added: 0, addedKeys: [] };
        const localParsed = this.parseLuaConfig(localContent);
        const upstreamParsed = this.parseLuaConfig(upstreamContent);

        let merged = localContent;
        const injectedBlocks = [];

        for (const [keyPath, upItem] of upstreamParsed.assignments.entries()) {
            if (localParsed.assignments.has(keyPath)) {
                stats.preserved++;

                if (upItem.isTable && localParsed.assignments.get(keyPath).isTable) {
                    const localTableItem = localParsed.assignments.get(keyPath);
                    const newSubKeys = [];

                    for (const [subKey, upSubVal] of upItem.subKeys.entries()) {
                        if (!localTableItem.subKeys.has(subKey)) {
                            newSubKeys.push({ subKey, raw: upSubVal.raw, comment: upSubVal.comment });
                        } else {
                            stats.preserved++;
                        }
                    }

                    if (newSubKeys.length > 0) {
                        merged = this.injectSubKeysIntoTable(merged, keyPath, newSubKeys);
                        for (const nk of newSubKeys) {
                            stats.added++;
                            stats.addedKeys.push(`${keyPath}.${nk.subKey}`);
                        }
                    }
                }
            } else {
                stats.added++;
                stats.addedKeys.push(keyPath);
                injectedBlocks.push(upItem.fullBlock);
            }
        }

        if (injectedBlocks.length > 0) {
            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const injectionHeader = [
                '',
                '--------------------------------------------------------------------------------',
                `-- [AutoUpdater] NEW SETTINGS INJECTED FROM GITHUB UPDATE (${timestamp} UTC)`,
                '-- The following options were added in the latest version of this script:',
                '--------------------------------------------------------------------------------',
                ...injectedBlocks,
                '--------------------------------------------------------------------------------',
                ''
            ].join('\n');

            merged = merged.trimEnd() + '\n' + injectionHeader;
        }

        return { mergedContent: merged, stats };
    }

    static injectSubKeysIntoTable(content, tableKeyPath, newSubKeys) {
        const escapedKey = tableKeyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tableRegex = new RegExp(`(${escapedKey}\\s*=\\s*\\{)`, 'g');
        const match = tableRegex.exec(content);

        if (!match) {
            const assignments = newSubKeys.map(k => {
                const comment = k.comment ? ` ${k.comment}` : '';
                return `${tableKeyPath}['${k.subKey}'] = ${k.raw.trim()}${comment}`;
            }).join('\n');

            return content.trimEnd() + '\n\n-- [AutoUpdater] New sub-settings added to ' + tableKeyPath + ':\n' + assignments + '\n';
        }

        const startPos = match.index + match[0].length;
        let braceCount = 1;
        let closePos = -1;
        let inString = false;
        let stringChar = '';

        for (let i = startPos; i < content.length; i++) {
            const char = content[i];
            const prevChar = i > 0 ? content[i - 1] : '';

            if (inString) {
                if (char === stringChar && prevChar !== '\\') {
                    inString = false;
                }
                continue;
            }

            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
            } else if (char === '{') {
                braceCount++;
            } else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                    closePos = i;
                    break;
                }
            }
        }

        if (closePos === -1) {
            return content;
        }

        const linesToInsert = newSubKeys.map(k => {
            const comment = k.comment ? ` ${k.comment}` : '';
            return `    ['${k.subKey}'] = ${k.raw.trim()},${comment} -- [New setting from update]`;
        }).join('\n');

        let beforeClose = content.substring(0, closePos).trimEnd();
        const lastLineMatch = beforeClose.match(/([^\n]+)$/);
        if (lastLineMatch) {
            const lastLine = lastLineMatch[1].trim();
            if (!lastLine.endsWith('{') && !lastLine.endsWith(',')) {
                const commentIdx = beforeClose.lastIndexOf('--');
                const lastLineStart = beforeClose.lastIndexOf('\n') + 1;
                if (commentIdx > lastLineStart) {
                    const beforeComment = beforeClose.substring(0, commentIdx).trimEnd();
                    if (!beforeComment.endsWith(',')) {
                        beforeClose = beforeComment + ', ' + beforeClose.substring(commentIdx);
                    }
                } else {
                    beforeClose += ',';
                }
            }
        }
        const afterClose = content.substring(closePos);

        return beforeClose + '\n' + linesToInsert + '\n' + afterClose;
    }

    static parseLuaConfig(luaCode) {
        const assignments = new Map();
        const lines = luaCode.split(/\r?\n/);

        let currentComments = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('--')) {
                currentComments.push(line);
                i++;
                continue;
            }

            if (trimmed === '') {
                if (currentComments.length > 5) {
                    currentComments = [];
                }
                i++;
                continue;
            }

            const assignmentMatch = trimmed.match(/^((?:Config|SETTINGS|Settings|Locale)(?:\.[a-zA-Z0-9_]+|\[['"][^'"]+['"]\])*)\s*=\s*(.*)$/);

            if (assignmentMatch) {
                let rawKey = assignmentMatch[1];
                let restOfLine = assignmentMatch[2];

                const normalizedKey = rawKey.replace(/\[['"]([^'"]+)['"]\]/g, '.$1');

                const fullValueResult = this.readFullLuaExpression(lines, i, restOfLine);
                const assignmentStatement = `${rawKey} = ${fullValueResult.rawText}`;
                const blockLines = [...currentComments, assignmentStatement];

                const isTable = fullValueResult.rawText.trim().startsWith('{');
                const subKeys = isTable ? this.extractTableSubKeys(fullValueResult.rawText) : new Map();

                assignments.set(normalizedKey, {
                    rawKey,
                    normalizedKey,
                    value: fullValueResult.rawText,
                    fullBlock: blockLines.join('\n'),
                    comments: currentComments.slice(),
                    isTable,
                    subKeys
                });

                i = fullValueResult.endLineIndex + 1;
                currentComments = [];
                continue;
            }

            const rootTableMatch = trimmed.match(/^(Config|SETTINGS|Settings)\s*=\s*\{/);
            if (rootTableMatch) {
                const rootName = rootTableMatch[1];
                const fullValueResult = this.readFullLuaExpression(lines, i, trimmed.substring(trimmed.indexOf('{')));
                const subKeys = this.extractTableSubKeys(fullValueResult.rawText);

                for (const [subKey, subVal] of subKeys.entries()) {
                    const fullKey = `${rootName}.${subKey}`;
                    const isSubTable = subVal.raw.trim().startsWith('{');
                    const nestedSubKeys = isSubTable ? this.extractTableSubKeys(subVal.raw) : new Map();

                    assignments.set(fullKey, {
                        rawKey: fullKey,
                        normalizedKey: fullKey,
                        value: subVal.raw,
                        fullBlock: `${fullKey} = ${subVal.raw}`,
                        comments: subVal.comment ? [subVal.comment] : [],
                        isTable: isSubTable,
                        subKeys: nestedSubKeys
                    });
                }

                i = fullValueResult.endLineIndex + 1;
                currentComments = [];
                continue;
            }

            currentComments = [];
            i++;
        }

        return { assignments };
    }

    static readFullLuaExpression(lines, startLineIndex, firstLineContent) {
        let text = firstLineContent;
        let braceCount = 0;
        let inFunction = false;
        let functionEndCount = 0;

        for (let i = startLineIndex; i < lines.length; i++) {
            const currentLine = i === startLineIndex ? firstLineContent : lines[i];

            for (let c of currentLine) {
                if (c === '{') braceCount++;
                if (c === '}') braceCount--;
            }

            if (/\bfunction\s*\(/.test(currentLine)) {
                inFunction = true;
                functionEndCount++;
            }
            if (/\bend\b/.test(currentLine) && inFunction) {
                functionEndCount--;
                if (functionEndCount <= 0) inFunction = false;
            }

            if (i > startLineIndex) {
                text += '\n' + lines[i];
            }

            if (braceCount <= 0 && !inFunction) {
                return {
                    rawText: text,
                    endLineIndex: i
                };
            }
        }

        return {
            rawText: text,
            endLineIndex: lines.length - 1
        };
    }

    static extractTableSubKeys(tableString) {
        const subKeys = new Map();
        const inner = tableString.replace(/^\{/, '').replace(/\}$/, '');
        const lines = inner.split(/\r?\n/);

        let pendingComment = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) {
                pendingComment = trimmed;
                continue;
            }

            const match = trimmed.match(/^(?:\[['"]([^'"]+)['"]\]|([a-zA-Z0-9_]+))\s*=\s*(.*)$/);
            if (match) {
                const key = match[1] || match[2];
                let valuePart = match[3];

                let comment = pendingComment;
                const commentIdx = valuePart.indexOf('--');
                if (commentIdx !== -1) {
                    comment = valuePart.substring(commentIdx).trim();
                    valuePart = valuePart.substring(0, commentIdx).trim();
                }

                if (valuePart.endsWith(',')) {
                    valuePart = valuePart.slice(0, -1).trim();
                }

                subKeys.set(key, {
                    raw: valuePart,
                    comment
                });

                pendingComment = '';
            }
        }

        return subKeys;
    }

    static mergeJson(localJsonStr, upstreamJsonStr) {
        const stats = { preserved: 0, added: 0, addedKeys: [] };

        let localObj, upstreamObj;
        try {
            localObj = JSON.parse(localJsonStr);
            upstreamObj = JSON.parse(upstreamJsonStr);
        } catch (e) {
            return { mergedContent: localJsonStr, stats };
        }

        const deepMerge = (target, source, currentPath = '') => {
            for (const [key, sourceVal] of Object.entries(source)) {
                const fullPath = currentPath ? `${currentPath}.${key}` : key;
                if (!(key in target)) {
                    target[key] = sourceVal;
                    stats.added++;
                    stats.addedKeys.push(fullPath);
                } else if (
                    typeof sourceVal === 'object' && sourceVal !== null && !Array.isArray(sourceVal) &&
                    typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])
                ) {
                    deepMerge(target[key], sourceVal, fullPath);
                } else {
                    stats.preserved++;
                }
            }
            return target;
        };

        const result = deepMerge(localObj, upstreamObj);
        return {
            mergedContent: JSON.stringify(result, null, 4),
            stats
        };
    }

    static createBackup(filePath) {
        if (!fs.existsSync(filePath)) return null;

        const dir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const backupDir = path.join(dir, '.updater_backups');

        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `${fileName}.${dateStr}.bak`);

        fs.copyFileSync(filePath, backupPath);
        return backupPath;
    }
}

module.exports = ConfigMerger;
