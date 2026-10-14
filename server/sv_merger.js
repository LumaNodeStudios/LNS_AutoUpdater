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

    static findMatchingBraceLine(lines, startLineIdx, startCharPos) {
        let braceCount = 0;
        let inString = false;
        let stringChar = '';
        let inBlockComment = false;

        for (let l = startLineIdx; l < lines.length; l++) {
            const line = lines[l];
            const startChar = (l === startLineIdx) ? startCharPos : 0;

            for (let c = startChar; c < line.length; c++) {
                const char = line[c];
                const nextChar = line[c + 1] || '';
                const prevChar = c > 0 ? line[c - 1] : '';

                if (inBlockComment) {
                    if (char === ']' && nextChar === ']') {
                        inBlockComment = false;
                        c++;
                    }
                    continue;
                }

                if (inString) {
                    if (char === stringChar && prevChar !== '\\') {
                        inString = false;
                    }
                    continue;
                }

                if (char === '-' && nextChar === '-') {
                    if (line[c + 2] === '[' && line[c + 3] === '[') {
                        inBlockComment = true;
                        c += 3;
                        continue;
                    }
                    break;
                }

                if (char === '"' || char === "'") {
                    inString = true;
                    stringChar = char;
                    continue;
                }

                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        return l;
                    }
                }
            }
        }
        return -1;
    }

    static checkHasTrailingComma(line) {
        let codePart = line;
        const commentIdx = line.indexOf('--');
        if (commentIdx !== -1) {
            codePart = line.substring(0, commentIdx);
        }
        return codePart.trim().endsWith(',');
    }

    static addTrailingComma(line) {
        const commentIdx = line.indexOf('--');
        if (commentIdx !== -1) {
            const before = line.substring(0, commentIdx).trimEnd();
            const comment = line.substring(commentIdx);
            if (!before.endsWith(',')) {
                return before + ', ' + comment;
            }
            return line;
        }
        const trimmed = line.trimEnd();
        if (!trimmed.endsWith(',')) {
            return trimmed + ',';
        }
        return line;
    }

    static parseLuaTableStructure(lines, startLineIdx, endLineIdx) {
        const entries = [];
        const entriesMap = new Map();
        let pendingComments = [];
        let hadLeadingBlank = false;
        let i = startLineIdx + 1;

        while (i < endLineIdx) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('--')) {
                pendingComments.push(line);
                i++;
                continue;
            }

            if (trimmed === '') {
                if (pendingComments.length > 0) {
                    pendingComments.push(line);
                } else {
                    hadLeadingBlank = true;
                }
                i++;
                continue;
            }

            const match = trimmed.match(/^(?:\[['"]?([^'"\]]+)['"]?\]|([a-zA-Z0-9_]+))\s*=\s*(.*)$/);
            if (match) {
                const key = match[1] || match[2];
                const rawKey = match[0].split('=')[0].trim();
                const valueRest = match[3].trim();
                const indentMatch = line.match(/^(\s*)/);
                const indent = indentMatch ? indentMatch[1] : '    ';

                const commentStartLine = pendingComments.length > 0
                    ? (i - pendingComments.length)
                    : i;

                const isTable = valueRest.startsWith('{');
                let entryEndLine = i;
                let subTable = null;

                if (isTable) {
                    const bracePos = line.indexOf('{');
                    entryEndLine = this.findMatchingBraceLine(lines, i, bracePos);
                    if (entryEndLine === -1) {
                        entryEndLine = i;
                    } else {
                        subTable = this.parseLuaTableStructure(lines, i, entryEndLine);
                    }
                }

                const lastLine = lines[entryEndLine];
                const hasComma = this.checkHasTrailingComma(lastLine);

                const entry = {
                    key,
                    rawKey,
                    commentLines: pendingComments.slice(),
                    commentStartLine,
                    assignmentStartLine: i,
                    endLine: entryEndLine,
                    indent,
                    isTable,
                    subTable,
                    hasComma,
                    hadLeadingBlank,
                    rawLines: lines.slice(commentStartLine, entryEndLine + 1)
                };

                entries.push(entry);
                entriesMap.set(key, entry);

                pendingComments = [];
                hadLeadingBlank = false;
                i = entryEndLine + 1;
                continue;
            }

            pendingComments = [];
            hadLeadingBlank = false;
            i++;
        }

        return {
            entries,
            entriesMap,
            startLineIdx,
            endLineIdx,
            openBracePos: lines[startLineIdx].indexOf('{')
        };
    }

    static findTableRoot(lines) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) continue;

            const match = trimmed.match(/^(?:(?:local\s+)?[a-zA-Z0-9_]+\s*=\s*\{|return\s*\{)/);
            if (match) {
                const bracePos = line.indexOf('{');
                const closeLine = this.findMatchingBraceLine(lines, i, bracePos);
                if (closeLine !== -1) {
                    return { startLine: i, closeLine, openBracePos: bracePos };
                }
            }
        }
        return null;
    }

    static mergeTablesContextually(localLines, localStruct, upStruct, stats, pathPrefix = '') {
        for (let i = 0; i < upStruct.entries.length; i++) {
            const upEntry = upStruct.entries[i];
            const currentPath = pathPrefix ? `${pathPrefix}.${upEntry.key}` : upEntry.key;

            if (localStruct.entriesMap.has(upEntry.key)) {
                const localEntry = localStruct.entriesMap.get(upEntry.key);
                stats.preserved++;

                if (upEntry.isTable && localEntry.isTable && upEntry.subTable && localEntry.subTable) {
                    this.mergeTablesContextually(localLines, localEntry.subTable, upEntry.subTable, stats, currentPath);
                    const newCloseLine = this.findMatchingBraceLine(localLines, localStruct.startLineIdx, localStruct.openBracePos);
                    localStruct = this.parseLuaTableStructure(localLines, localStruct.startLineIdx, newCloseLine);
                }
            } else {
                stats.added++;
                stats.addedKeys.push(currentPath);

                let anchorKey = null;
                let insertPos = 'after';

                for (let p = i - 1; p >= 0; p--) {
                    const candKey = upStruct.entries[p].key;
                    if (localStruct.entriesMap.has(candKey)) {
                        anchorKey = candKey;
                        insertPos = 'after';
                        break;
                    }
                }

                if (!anchorKey) {
                    for (let n = i + 1; n < upStruct.entries.length; n++) {
                        const candKey = upStruct.entries[n].key;
                        if (localStruct.entriesMap.has(candKey)) {
                            anchorKey = candKey;
                            insertPos = 'before';
                            break;
                        }
                    }
                }

                let targetLineIdx = -1;

                if (anchorKey && insertPos === 'after') {
                    const anchorEntry = localStruct.entriesMap.get(anchorKey);
                    localLines[anchorEntry.endLine] = this.addTrailingComma(localLines[anchorEntry.endLine]);
                    targetLineIdx = anchorEntry.endLine + 1;
                } else if (anchorKey && insertPos === 'before') {
                    const anchorEntry = localStruct.entriesMap.get(anchorKey);
                    targetLineIdx = anchorEntry.commentStartLine;
                } else {
                    targetLineIdx = localStruct.endLineIdx;
                    let prevNonEmpty = targetLineIdx - 1;
                    while (prevNonEmpty > localStruct.startLineIdx && localLines[prevNonEmpty].trim() === '') {
                        prevNonEmpty--;
                    }
                    if (prevNonEmpty > localStruct.startLineIdx) {
                        localLines[prevNonEmpty] = this.addTrailingComma(localLines[prevNonEmpty]);
                    }
                }

                const linesToInsert = [];
                if (insertPos === 'after' && (upEntry.hadLeadingBlank || upEntry.commentLines.length > 0)) {
                    const prevLine = localLines[targetLineIdx - 1];
                    if (prevLine && prevLine.trim() !== '') {
                        linesToInsert.push('');
                    }
                }

                for (let r = 0; r < upEntry.rawLines.length; r++) {
                    linesToInsert.push(upEntry.rawLines[r]);
                }

                const lastIdx = linesToInsert.length - 1;
                linesToInsert[lastIdx] = this.addTrailingComma(linesToInsert[lastIdx]);

                if (insertPos === 'before' && (upEntry.hadLeadingBlank || upEntry.commentLines.length > 0)) {
                    linesToInsert.push('');
                }

                localLines.splice(targetLineIdx, 0, ...linesToInsert);

                const newCloseLine = this.findMatchingBraceLine(localLines, localStruct.startLineIdx, localStruct.openBracePos);
                localStruct = this.parseLuaTableStructure(localLines, localStruct.startLineIdx, newCloseLine);
            }
        }
    }

    static mergeLuaReturnTable(localCode, upstreamCode) {
        const stats = { preserved: 0, added: 0, addedKeys: [] };
        const eol = localCode.includes('\r\n') ? '\r\n' : '\n';

        const localLines = localCode.split(/\r?\n/);
        const upstreamLines = upstreamCode.split(/\r?\n/);

        const localRoot = this.findTableRoot(localLines);
        const upRoot = this.findTableRoot(upstreamLines);

        if (!localRoot || !upRoot) {
            return null;
        }

        const localStruct = this.parseLuaTableStructure(localLines, localRoot.startLine, localRoot.closeLine);
        const upStruct = this.parseLuaTableStructure(upstreamLines, upRoot.startLine, upRoot.closeLine);

        if (localStruct.entries.length === 0 && upStruct.entries.length === 0) {
            return null;
        }

        this.mergeTablesContextually(localLines, localStruct, upStruct, stats);

        return {
            mergedContent: localLines.join(eol),
            stats
        };
    }

    static mergeLua(localContent, upstreamContent) {
        const isTableFormat = /^\s*(?:return\s*\{|(?:local\s+)?[a-zA-Z0-9_]+\s*=\s*\{)/m.test(localContent) ||
            /^\s*(?:return\s*\{|(?:local\s+)?[a-zA-Z0-9_]+\s*=\s*\{)/m.test(upstreamContent);

        if (isTableFormat) {
            const tableResult = this.mergeLuaReturnTable(localContent, upstreamContent);
            if (tableResult && (tableResult.stats.preserved > 0 || tableResult.stats.added > 0)) {
                return tableResult;
            }
        }

        const stats = { preserved: 0, added: 0, addedKeys: [] };
        const localParsed = this.parseLuaConfig(localContent);
        const upstreamParsed = this.parseLuaConfig(upstreamContent);

        const eol = localContent.includes('\r\n') ? '\r\n' : '\n';
        let localLines = localContent.split(/\r?\n/);

        const upstreamKeys = Array.from(upstreamParsed.assignments.keys());

        for (let i = 0; i < upstreamKeys.length; i++) {
            const keyPath = upstreamKeys[i];
            const upItem = upstreamParsed.assignments.get(keyPath);

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
                        const mergedStr = this.injectSubKeysIntoTable(localLines.join(eol), keyPath, newSubKeys);
                        localLines = mergedStr.split(/\r?\n/);
                        for (const nk of newSubKeys) {
                            stats.added++;
                            stats.addedKeys.push(`${keyPath}.${nk.subKey}`);
                        }
                    }
                }
            } else {
                stats.added++;
                stats.addedKeys.push(keyPath);

                let anchorKey = null;
                let insertPos = 'after';

                for (let p = i - 1; p >= 0; p--) {
                    const prevKey = upstreamKeys[p];
                    if (localParsed.assignments.has(prevKey)) {
                        anchorKey = prevKey;
                        insertPos = 'after';
                        break;
                    }
                }

                if (!anchorKey) {
                    for (let n = i + 1; n < upstreamKeys.length; n++) {
                        const nextKey = upstreamKeys[n];
                        if (localParsed.assignments.has(nextKey)) {
                            anchorKey = nextKey;
                            insertPos = 'before';
                            break;
                        }
                    }
                }

                const blockLines = upItem.fullBlock.split(/\r?\n/);

                if (anchorKey && insertPos === 'after') {
                    const anchorItem = localParsed.assignments.get(anchorKey);
                    const anchorIdx = localLines.findIndex(l => l.includes(anchorItem.rawKey));
                    if (anchorIdx !== -1) {
                        localLines.splice(anchorIdx + 1, 0, '', ...blockLines);
                    } else {
                        localLines.push('', ...blockLines);
                    }
                } else if (anchorKey && insertPos === 'before') {
                    const anchorItem = localParsed.assignments.get(anchorKey);
                    const anchorIdx = localLines.findIndex(l => l.includes(anchorItem.rawKey));
                    if (anchorIdx !== -1) {
                        localLines.splice(anchorIdx, 0, ...blockLines, '');
                    } else {
                        localLines.push('', ...blockLines);
                    }
                } else {
                    localLines.push('', ...blockLines);
                }
            }
        }

        return { mergedContent: localLines.join(eol), stats };
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

            return content.trimEnd() + '\n\n' + assignments + '\n';
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
            return `    ['${k.subKey}'] = ${k.raw.trim()},${comment}`;
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
            const cleanLocal = localJsonStr.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? '' : m);
            const cleanUpstream = upstreamJsonStr.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? '' : m);
            localObj = JSON.parse(cleanLocal);
            upstreamObj = JSON.parse(cleanUpstream);
        } catch (e) {
            return { mergedContent: localJsonStr, stats };
        }

        const deepMergeOrdered = (target, source, currentPath = '') => {
            const merged = {};

            for (const [key, sourceVal] of Object.entries(source)) {
                const fullPath = currentPath ? `${currentPath}.${key}` : key;
                if (!(key in target)) {
                    merged[key] = sourceVal;
                    stats.added++;
                    stats.addedKeys.push(fullPath);
                } else if (
                    typeof sourceVal === 'object' && sourceVal !== null && !Array.isArray(sourceVal) &&
                    typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])
                ) {
                    merged[key] = deepMergeOrdered(target[key], sourceVal, fullPath);
                } else {
                    merged[key] = target[key];
                    stats.preserved++;
                }
            }

            for (const [key, targetVal] of Object.entries(target)) {
                if (!(key in merged)) {
                    merged[key] = targetVal;
                    stats.preserved++;
                }
            }

            return merged;
        };

        const result = deepMergeOrdered(localObj, upstreamObj);
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
