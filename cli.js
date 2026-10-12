const { AutoUpdaterCore, config } = require('./server/sv_main');
const { Logger, Colors } = require('./server/sv_utils');

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || '--help';

    console.log(`\n${Colors.Bright}${Colors.Cyan}=== FiveM Smart AutoUpdater CLI ===${Colors.Reset}\n`);

    if (command === '--check' || command === '-c') {
        Logger.info('Checking all managed scripts for updates...');
        const updates = await AutoUpdaterCore.checkAll(false);
        if (updates.length === 0) {
            Logger.success('All resources are currently up to date!');
        } else {
            Logger.warn(`${updates.length} resource(s) have pending updates.`);
        }
    } else if (command === '--update' || command === '-u') {
        const target = args[1];
        if (!target) {
            Logger.error('Please specify a resource name: node cli.js --update <resourceName>');
            process.exit(1);
        }

        const script = config.managedScripts.find(s => s.resourceName.toLowerCase() === target.toLowerCase());
        if (!script) {
            Logger.error(`Resource "${target}" not found in config.json managedScripts.`);
            process.exit(1);
        }

        try {
            await AutoUpdaterCore.updateResource(script);
        } catch (e) {
            Logger.error('Update failed:', e.message);
            process.exit(1);
        }
    } else if (command === '--update-all' || command === '-a') {
        Logger.info('Updating all resources with pending updates...');
        const updates = await AutoUpdaterCore.checkAll(true);
        for (const item of updates) {
            try {
                await AutoUpdaterCore.updateResource(item.script);
            } catch (e) {
                Logger.error(`Failed to update ${item.script.resourceName}:`, e.message);
            }
        }
    } else {
        console.log(`Usage:
            node cli.js --check                 Check all scripts for available updates
            node cli.js --update <name>         Update a specific script with smart config merge
            node cli.js --update-all            Update all scripts that have updates available
            node cli.js --help                  Show this help menu
        `);
    }
}

main().catch(err => {
    Logger.error('Fatal CLI error:', err.message);
    process.exit(1);
});