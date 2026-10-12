const fs = require('fs');
const path = require('path');

const Colors = {
    Reset: '\x1b[0m',
    Bright: '\x1b[1m',
    Dim: '\x1b[2m',
    Red: '\x1b[31m',
    Green: '\x1b[32m',
    Yellow: '\x1b[33m',
    Blue: '\x1b[34m',
    Magenta: '\x1b[35m',
    Cyan: '\x1b[36m'
};

class Logger {
    static formatPrefix() {
        const time = new Date().toLocaleTimeString();
        return `${Colors.Cyan}[AutoUpdater ${time}]${Colors.Reset}`;
    }

    static info(...args) {
        console.log(`${this.formatPrefix()} ${Colors.Blue}ℹ${Colors.Reset}`, ...args);
    }

    static success(...args) {
        console.log(`${this.formatPrefix()} ${Colors.Green}✔${Colors.Reset}`, ...args);
    }

    static warn(...args) {
        console.warn(`${this.formatPrefix()} ${Colors.Yellow}⚠${Colors.Reset}`, ...args);
    }

    static error(...args) {
        console.error(`${this.formatPrefix()} ${Colors.Red}✖${Colors.Reset}`, ...args);
    }
}

class PathHelper {
    static getResourceRoot(resourceName) {
        if (typeof GetResourcePath === 'function') {
            const fxPath = GetResourcePath(resourceName);
            if (fxPath) return path.resolve(fxPath);
        }

        return path.resolve(process.cwd(), '..', resourceName);
    }

    static shouldIgnore(relPath, ignorePatterns = []) {
        const normalized = relPath.replace(/\\/g, '/');
        const filename = path.basename(normalized);

        for (const pattern of ignorePatterns) {
            const normPattern = pattern.replace(/\\/g, '/');
            if (normPattern.endsWith('/*')) {
                const folderPrefix = normPattern.slice(0, -2);
                if (normalized.startsWith(folderPrefix + '/') || normalized === folderPrefix) {
                    return true;
                }
            } else if (normPattern.startsWith('*.')) {
                const ext = normPattern.slice(1);
                if (normalized.endsWith(ext)) return true;
            } else if (normPattern.endsWith('*')) {
                const prefix = normPattern.slice(0, -1);
                if (filename.startsWith(prefix) || normalized.startsWith(prefix)) return true;
            } else {
                if (normalized === normPattern || filename === normPattern) return true;
            }
        }
        return false;
    }

    static isConfigFile(relPath, configFilesList = []) {
        const normalized = relPath.replace(/\\/g, '/').toLowerCase();
        for (const cfg of configFilesList) {
            const normCfg = cfg.replace(/\\/g, '/').toLowerCase();
            if (normalized === normCfg || path.basename(normalized) === normCfg) {
                return true;
            }
        }
        if (configFilesList.length === 0) {
            const base = path.basename(normalized);
            return base === 'config.lua' || base === 'settings.lua' || base === 'config.json';
        }
        return false;
    }
}

class StateManager {
    static loadResourceState(resourceDir) {
        const stateFile = path.join(resourceDir, '.updater_state.json');
        if (fs.existsSync(stateFile)) {
            try {
                return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            } catch (e) {
                return {};
            }
        }
        return {};
    }

    static saveResourceState(resourceDir, stateData) {
        const stateFile = path.join(resourceDir, '.updater_state.json');
        try {
            fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2), 'utf8');
        } catch (e) {
            Logger.warn(`Could not save state file at ${stateFile}: ${e.message}`);
        }
    }
}

module.exports = {
    Colors,
    Logger,
    PathHelper,
    StateManager
};
