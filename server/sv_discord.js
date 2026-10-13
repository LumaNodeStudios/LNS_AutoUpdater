const https = require('https');
const url = require('url');

class DiscordNotifier {
    constructor(webhookUrl) {
        this.webhookUrl = webhookUrl;
    }

    async sendEmbed({ title, description, color = 0x3498db, fields = [], footer = null }) {
        if (!this.webhookUrl || !this.webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
            return;
        }

        const payload = {
            username: 'LumaNode AutoUpdater',
            avatar_url: 'https://r2.fivemanage.com/ikenZGXRwE4faTVyko8MZ/LumaNode_Original.png',
            embeds: [
                {
                    title,
                    description,
                    color,
                    fields,
                    footer: footer || { text: 'LumaNode AutoUpdater' },
                    timestamp: new Date().toISOString()
                }
            ]
        };

        return new Promise((resolve) => {
            try {
                const parsedUrl = new url.URL(this.webhookUrl);
                const data = JSON.stringify(payload);

                const req = https.request({
                    hostname: parsedUrl.hostname,
                    port: 443,
                    path: parsedUrl.pathname + parsedUrl.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    }
                }, (res) => {
                    resolve(res.statusCode >= 200 && res.statusCode < 300);
                });

                req.on('error', (err) => {
                    console.error('[AutoUpdater:Discord] Webhook send failed:', err.message);
                    resolve(false);
                });

                req.write(data);
                req.end();
            } catch (e) {
                console.error('[AutoUpdater:Discord] Invalid webhook URL or payload:', e.message);
                resolve(false);
            }
        });
    }

    async notifyUpdateSuccess({ resourceName, repo, ref, message, author, updatedFilesCount, configStats }) {
        const fields = [
            { name: 'Resource', value: `\`${resourceName}\``, inline: true },
            { name: 'GitHub Repository', value: `[${repo}](https://github.com/${repo})`, inline: true },
            { name: 'Commit / Ref', value: `\`${ref}\``, inline: true },
            { name: 'Commit Message', value: message || 'Latest update from repository', inline: false },
            { name: 'Author', value: author || 'Unknown', inline: true },
            { name: 'Files Updated', value: `${updatedFilesCount} files`, inline: true }
        ];

        if (configStats) {
            let configDetails = `Preserved settings: **${configStats.preserved}**\n`;
            if (configStats.added > 0) {
                configDetails += `New settings injected: **${configStats.added}** (\`${configStats.addedKeys.slice(0, 5).join('`, `')}${configStats.addedKeys.length > 5 ? '... and more' : ''}\`)`;
            } else {
                configDetails += `No new config keys required injection.`;
            }
            fields.push({
                name: 'Configuration Merge',
                value: configDetails,
                inline: false
            });
        }

        return this.sendEmbed({
            title: `Script Updated: ${resourceName}`,
            description: `Successfully pulled the latest update from GitHub and applied configuration preservation.`,
            color: 0x2ecc71,
            fields
        });
    }

    async notifyUpdateAvailable({ resourceName, repo, ref, message }) {
        return this.sendEmbed({
            title: `Update Available: ${resourceName}`,
            description: `A new update is available on GitHub. Run \`/update ${resourceName}\` to apply it.`,
            color: 0xf39c12,
            fields: [
                { name: 'Resource', value: `\`${resourceName}\``, inline: true },
                { name: 'GitHub Repository', value: `[${repo}](https://github.com/${repo})`, inline: true },
                { name: 'New Ref', value: `\`${ref}\``, inline: true },
                { name: 'Changelog', value: message || 'No description provided', inline: false }
            ]
        });
    }

    async notifyError({ resourceName, error, action = 'update' }) {
        const isCheck = action === 'check';
        return this.sendEmbed({
            title: isCheck ? `Update Check Failed: ${resourceName}` : `Update Failed: ${resourceName}`,
            description: isCheck
                ? `An error occurred while checking GitHub for updates.`
                : `An error occurred while attempting to update the script.`,
            color: 0xe74c3c,
            fields: [
                { name: 'Resource', value: `\`${resourceName}\``, inline: true },
                { name: 'Error Details', value: `\`\`\`\n${error}\n\`\`\``, inline: false }
            ]
        });
    }
}

module.exports = DiscordNotifier;