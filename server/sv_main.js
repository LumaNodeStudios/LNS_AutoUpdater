const fs = require('fs');
const path = require('path');
const isFXServer = typeof GetCurrentResourceName === 'function';
const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
const resourceDir = isFXServer ? GetResourcePath(GetCurrentResourceName()) : path.resolve(currentDir, '..');
const configPath = path.join(resourceDir, 'config.json');

function requireServerModule(moduleName) {
    if (isFXServer) {
        const fullPath = path.join(resourceDir, 'server', moduleName);
        if (fs.existsSync(fullPath + '.js') || fs.existsSync(fullPath)) {
            return require(fullPath);
        }
        return require(`./server/${moduleName}`);
    }

    const candidatePaths = [
        path.join(currentDir, moduleName),
        path.join(currentDir, 'server', moduleName),
        `./${moduleName}`,
        `./server/${moduleName}`
    ];

    for (const cand of candidatePaths) {
        if (fs.existsSync(cand + '.js') || fs.existsSync(cand)) {
            return require(cand);
        }
    }
    return require(`./${moduleName}`);
}

const GitHubClient = requireServerModule('sv_github');
const ZipExtractor = requireServerModule('sv_zip');
const ConfigMerger = requireServerModule('sv_merger');
const DiscordNotifier = requireServerModule('sv_discord');
const { Colors, Logger, PathHelper, StateManager } = requireServerModule('sv_utils');

let config = {
    checkIntervalMinutes: 60,
    githubToken: null,
    backupConfigs: true,
    autoRestartResource: true,
    adminAcePermission: 'command.update',
    discordWebhook: null,
    managedScripts: []
};

if (fs.existsSync(configPath)) {
    try {
        const loadedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config = { ...config, ...loadedConfig };
    } catch (e) {
        Logger.error('Failed to parse config.json:', e.message);
    }
} else {
    Logger.warn('config.json not found, using default configuration.');
}

const github = new GitHubClient(config.githubToken || null);
const discord = new DiscordNotifier(config.discordWebhook || null);

class AutoUpdaterCore {
    static async checkForUpdate(scriptConfig) {
        const resourceName = scriptConfig.resourceName;
        const targetDir = PathHelper.getResourceRoot(resourceName);

        if (!fs.existsSync(targetDir)) {
            throw new Error(`Target resource directory does not exist: "${targetDir}". Make sure the resource is installed.`);
        }

        const state = StateManager.loadResourceState(targetDir);
        const currentSha = state.sha || null;
        const currentTag = state.tag || null;

        if (scriptConfig.useReleases) {
            const release = await github.getLatestRelease(scriptConfig.githubRepo);
            const hasUpdate = !currentTag || currentTag !== release.tagName;
            return {
                hasUpdate,
                latestInfo: {
                    type: 'release',
                    ref: release.tagName,
                    name: release.name,
                    message: release.body,
                    date: release.publishedAt,
                    url: release.url
                },
                currentRef: currentTag
            };
        } else {
            const branch = scriptConfig.branch || 'main';
            const commit = await github.getLatestCommit(scriptConfig.githubRepo, branch);
            const hasUpdate = !currentSha || currentSha !== commit.sha;
            return {
                hasUpdate,
                latestInfo: {
                    type: 'commit',
                    ref: commit.sha,
                    shortRef: commit.shortSha,
                    message: commit.message,
                    author: commit.author,
                    date: commit.date,
                    url: commit.url
                },
                currentRef: currentSha ? currentSha.substring(0, 7) : 'None'
            };
        }
    }

    static async updateResource(scriptConfig) {
        const resourceName = scriptConfig.resourceName;
        const targetDir = PathHelper.getResourceRoot(resourceName);

        Logger.info(`Starting update for resource ${Colors.Cyan}${resourceName}${Colors.Reset} from ${scriptConfig.githubRepo}...`);

        const updateCheck = await this.checkForUpdate(scriptConfig);
        const latestInfo = updateCheck.latestInfo;
        const refToDownload = latestInfo.ref;

        Logger.info(`Downloading zipball from GitHub (${refToDownload})...`);
        const zipBuffer = await github.downloadZipball(scriptConfig.githubRepo, refToDownload);

        const extractedFiles = ZipExtractor.parse(zipBuffer, {
            subfolder: scriptConfig.subfolder || ''
        });

        const defaultIgnores = ['.git*', '.github/*', 'README.md', 'LICENSE', '.gitignore'];
        const customIgnores = (Array.isArray(scriptConfig.ignoreFiles) && scriptConfig.ignoreFiles.length > 0)
            ? scriptConfig.ignoreFiles
            : [];
        const ignoreList = [...new Set([...defaultIgnores, ...customIgnores])];
        const configList = (Array.isArray(scriptConfig.configFiles) && scriptConfig.configFiles.length > 0)
            ? scriptConfig.configFiles
            : ['config.lua', 'settings.lua', 'config.json'];

        let updatedFilesCount = 0;
        let totalConfigStats = { preserved: 0, added: 0, addedKeys: [] };

        for (const file of extractedFiles) {
            if (PathHelper.shouldIgnore(file.path, ignoreList)) {
                continue;
            }

            const destinationPath = path.join(targetDir, file.path);

            if (file.isDirectory) {
                if (!fs.existsSync(destinationPath)) {
                    fs.mkdirSync(destinationPath, { recursive: true });
                }
                continue;
            }

            const parentDir = path.dirname(destinationPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            const isConfig = PathHelper.isConfigFile(file.path, configList);

            if (isConfig && fs.existsSync(destinationPath)) {
                Logger.info(`Smart-merging configuration: ${Colors.Yellow}${file.path}${Colors.Reset}...`);

                if (config.backupConfigs) {
                    const backupPath = ConfigMerger.createBackup(destinationPath);
                    if (backupPath) {
                        Logger.info(`Created backup at: ${Colors.Dim}${path.basename(backupPath)}${Colors.Reset}`);
                    }
                }

                const localContent = fs.readFileSync(destinationPath, 'utf8');
                const upstreamContent = file.data.toString('utf8');

                const mergeResult = ConfigMerger.merge(file.path, localContent, upstreamContent);
                fs.writeFileSync(destinationPath, mergeResult.mergedContent, 'utf8');

                totalConfigStats.preserved += mergeResult.stats.preserved;
                totalConfigStats.added += mergeResult.stats.added;
                totalConfigStats.addedKeys.push(...mergeResult.stats.addedKeys);

                Logger.success(`Config merged: Preserved ${mergeResult.stats.preserved} settings, injected ${mergeResult.stats.added} new settings.`);
            } else {
                fs.writeFileSync(destinationPath, file.data);
            }

            updatedFilesCount++;
        }

        const manifestPath = path.join(targetDir, 'fxmanifest.lua');
        if (fs.existsSync(manifestPath) && latestInfo.type === 'release' && latestInfo.ref) {
            const rawVersion = latestInfo.ref.replace(/^v/i, '').trim();
            if (rawVersion) {
                try {
                    let manifestContent = fs.readFileSync(manifestPath, 'utf8');
                    const versionRegex = /(version\s+['"])([^'"]+)(['"])/i;
                    if (versionRegex.test(manifestContent)) {
                        const currentManifestVersion = manifestContent.match(versionRegex)[2];
                        if (currentManifestVersion !== rawVersion) {
                            manifestContent = manifestContent.replace(versionRegex, `$1${rawVersion}$3`);
                            fs.writeFileSync(manifestPath, manifestContent, 'utf8');
                            Logger.success(`Updated ${Colors.Cyan}${resourceName}${Colors.Reset} fxmanifest.lua version: ${Colors.Yellow}${currentManifestVersion}${Colors.Reset} -> ${Colors.Green}${rawVersion}${Colors.Reset}`);
                        }
                    }
                } catch (err) {
                    Logger.warn(`Could not sync fxmanifest.lua version: ${err.message}`);
                }
            }
        }

        StateManager.saveResourceState(targetDir, {
            repo: scriptConfig.githubRepo,
            ref: latestInfo.ref,
            sha: latestInfo.type === 'commit' ? latestInfo.ref : null,
            tag: latestInfo.type === 'release' ? latestInfo.ref : null,
            updatedAt: new Date().toISOString(),
            lastCommitMessage: latestInfo.message
        });

        Logger.success(`Update complete for ${Colors.Green}${resourceName}${Colors.Reset}! (${updatedFilesCount} files updated)`);

        if (config.autoRestartResource && isFXServer) {
            Logger.info(`Restarting resource ${resourceName} via FXServer command...`);
            ExecuteCommand(`restart ${resourceName}`);
        }

        await discord.notifyUpdateSuccess({
            resourceName,
            repo: scriptConfig.githubRepo,
            ref: latestInfo.shortRef || latestInfo.ref,
            message: latestInfo.message,
            author: latestInfo.author,
            updatedFilesCount,
            configStats: totalConfigStats
        });

        return {
            resourceName,
            updatedFilesCount,
            configStats: totalConfigStats,
            latestInfo
        };
    }

    static async checkAll(silentIfUpToDate = false) {
        Logger.info(`Checking updates for ${config.managedScripts.length} managed script(s)...`);
        const updatesAvailable = [];

        for (const script of config.managedScripts) {
            try {
                const check = await this.checkForUpdate(script);
                if (check.hasUpdate) {
                    updatesAvailable.push({ script, check });
                    Logger.warn(`Update available for ${Colors.Yellow}${script.resourceName}${Colors.Reset} (${check.currentRef} -> ${check.latestInfo.shortRef || check.latestInfo.ref}): ${check.latestInfo.message}`);

                    if (script.autoUpdate) {
                        Logger.info(`Auto-update is enabled for ${script.resourceName}. Starting auto-update...`);
                        await this.updateResource(script);
                    } else {
                        await discord.notifyUpdateAvailable({
                            resourceName: script.resourceName,
                            repo: script.githubRepo,
                            ref: check.latestInfo.shortRef || check.latestInfo.ref,
                            message: check.latestInfo.message
                        });
                    }
                } else if (!silentIfUpToDate) {
                    Logger.info(`Resource ${Colors.Green}${script.resourceName}${Colors.Reset} is up to date (${check.currentRef}).`);
                }
            } catch (err) {
                Logger.error(`Error checking ${script.resourceName}:`, err.message);
                await discord.notifyError({ resourceName: script.resourceName, error: err.message });
            }
        }

        return updatesAvailable;
    }
}

function hasPermission(source) {
    if (source === 0) return true;
    if (typeof IsPlayerAceAllowed === 'function') {
        return IsPlayerAceAllowed(source, config.adminAcePermission || 'command.update');
    }
    return false;
}

function sendFeedback(source, message) {
    if (source === 0) {
        console.log(`[AutoUpdater] ${message}`);
    } else if (isFXServer) {
        TriggerClientEvent('chat:addMessage', source, {
            color: [52, 152, 219],
            multiline: true,
            args: ['AutoUpdater', message]
        });
    }
}

if (isFXServer) {
    RegisterCommand('checkupdates', async (source, args) => {
        if (!hasPermission(source)) {
            sendFeedback(source, '^1Access denied. You do not have permission to check updates.');
            return;
        }

        const targetResource = args[0] ? args[0].toLowerCase() : null;
        sendFeedback(source, '^3Checking for GitHub script updates...');

        if (targetResource) {
            const script = config.managedScripts.find(s => s.resourceName.toLowerCase() === targetResource);
            if (!script) {
                sendFeedback(source, `^1Resource "${targetResource}" is not configured in config.json.`);
                return;
            }

            try {
                const check = await AutoUpdaterCore.checkForUpdate(script);
                if (check.hasUpdate) {
                    sendFeedback(source, `^2Update available for ^3${script.resourceName}^2! Run ^3/update ${script.resourceName}^2 to apply.`);
                } else {
                    sendFeedback(source, `^2Resource ^3${script.resourceName}^2 is already up to date!`);
                }
            } catch (e) {
                sendFeedback(source, `^1Error: ${e.message}`);
            }
        } else {
            const results = await AutoUpdaterCore.checkAll();
            sendFeedback(source, `^2Check completed. ${results.length} update(s) pending.`);
        }
    }, false);

    RegisterCommand('update', async (source, args) => {
        if (!hasPermission(source)) {
            sendFeedback(source, '^1Access denied. You do not have permission to update scripts.');
            return;
        }

        if (!args[0]) {
            sendFeedback(source, '^1Usage: /update <resourceName> (or /updateall)');
            return;
        }

        const targetResource = args[0].toLowerCase();
        const script = config.managedScripts.find(s => s.resourceName.toLowerCase() === targetResource);

        if (!script) {
            sendFeedback(source, `^1Resource "${targetResource}" is not in config.json managed scripts.`);
            return;
        }

        sendFeedback(source, `^3Updating "${script.resourceName}" from GitHub...`);

        try {
            const result = await AutoUpdaterCore.updateResource(script);
            sendFeedback(source, `^2Successfully updated ^3${script.resourceName}^2! Config preserved (${result.configStats.preserved} settings).`);
        } catch (e) {
            sendFeedback(source, `^1Update failed: ${e.message}`);
        }
    }, false);

    RegisterCommand('updateall', async (source) => {
        if (!hasPermission(source)) {
            sendFeedback(source, '^1Access denied.');
            return;
        }

        sendFeedback(source, '^3Checking and updating all pending scripts...');
        let updatedCount = 0;

        for (const script of config.managedScripts) {
            try {
                const check = await AutoUpdaterCore.checkForUpdate(script);
                if (check.hasUpdate) {
                    sendFeedback(source, `^3Updating ${script.resourceName}...`);
                    await AutoUpdaterCore.updateResource(script);
                    updatedCount++;
                }
            } catch (e) {
                sendFeedback(source, `^1Error updating ${script.resourceName}: ${e.message}`);
            }
        }

        sendFeedback(source, `^2Update cycle complete. ${updatedCount} resource(s) updated.`);
    }, false);

    setImmediate(() => {
        Logger.info(`${Colors.Bright}FiveM Smart AutoUpdater initialized!${Colors.Reset}`);
        Logger.info(`Tracking ${config.managedScripts.length} managed script(s). Smart Config Preservation active.`);

        AutoUpdaterCore.checkAll(true).catch(e => Logger.error('Boot check error:', e.message));

        if (config.checkIntervalMinutes > 0) {
            const ms = config.checkIntervalMinutes * 60 * 1000;
            setInterval(() => {
                AutoUpdaterCore.checkAll(true).catch(e => Logger.error('Interval check error:', e.message));
            }, ms);
            Logger.info(`Scheduled background checks every ${config.checkIntervalMinutes} minute(s).`);
        }
    });

    const cfxExports = (typeof globalThis !== 'undefined' && typeof globalThis.exports === 'function')
        ? globalThis.exports
        : (typeof global !== 'undefined' && typeof global.exports === 'function')
            ? global.exports
            : (typeof exports === 'function' ? exports : null);

    if (cfxExports) {
        cfxExports('CheckForUpdates', (resourceName) => {
            const script = config.managedScripts.find(s => s.resourceName.toLowerCase() === (resourceName || '').toLowerCase());
            if (!script) return Promise.reject(new Error('Resource not managed'));
            return AutoUpdaterCore.checkForUpdate(script);
        });

        cfxExports('UpdateResource', (resourceName) => {
            const script = config.managedScripts.find(s => s.resourceName.toLowerCase() === (resourceName || '').toLowerCase());
            if (!script) return Promise.reject(new Error('Resource not managed'));
            return AutoUpdaterCore.updateResource(script);
        });
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        AutoUpdaterCore,
        config
    };
}