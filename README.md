# LNS_AutoUpdater

Automated GitHub resource updater for FiveM servers with smart configuration preservation, Discord notifications, automated backups, and standalone CLI support.

Developed by LumaNode Studios.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Permissions (ACE)](#permissions-ace)
- [Configuration Guide](#configuration-guide)
  - [Root Configuration](#root-configuration)
  - [Managed Resource Configuration](#managed-resource-configuration)
  - [Example `config.json`](#example-configjson)
- [Usage](#usage)
  - [In-Game & Server Console Commands](#in-game--server-console-commands)
  - [Standalone Command Line Interface (CLI)](#standalone-command-line-interface-cli)
  - [Lua / JS Exports](#lua--js-exports)
- [Smart Config Preservation](#smart-config-preservation)
- [File Ignoring & Subfolders](#file-ignoring--subfolders)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [License](#license)

---

## Overview

Managing updates for multiple FiveM scripts often results in lost server configurations, tedious manual diffing, and downtime. **LNS_AutoUpdater** solves this by monitoring GitHub repositories (releases or branch commits), downloading upstream updates, and smartly merging them into your server resources while keeping all of your local configuration values, comments, and custom variables intact.

It operates seamlessly as both an active FiveM server resource and a standalone Node.js CLI tool.

---

## Key Features

- **Smart Configuration Preservation**: Automatically merges incoming Lua and JSON configuration files. Preserves your customized database strings, framework settings, and prices while injecting new variables added by upstream authors.
- **Automatic Config Backups**: Generates timestamped backups in `.updater_backups/` before any configuration file is altered.
- **Release and Branch Tracking**: Track official tagged GitHub Releases (e.g., `v1.2.0`) or follow bleeding-edge branch commits (e.g., `main`, `master`).
- **Discord Webhook Alerts**: Sends rich embeds for update availability, update success with changelogs and stats, and error notifications.
- **Auto-Restart Integration**: Optionally restarts updated resources instantly via FXServer console commands.
- **Zero External Dependencies**: Built with native Node.js APIs (`https`, `zlib`, `fs`). No `npm install` or third-party packages required.
- **Dual Runtime Support**: Runs inside FXServer as a background service or outside FXServer via Node.js CLI.
- **Fine-Grained Permissions**: Restrict update and check commands to authorized administrators using FiveM ACE permissions.

---

## Requirements

- **FiveM FXServer**: Any modern FXServer build (Cerulean or higher) with standard Node.js runtime enabled.
- **Standalone CLI (Optional)**: Node.js version 16.0.0 or higher installed on the host system.
- **Internet Access**: The server host must have outbound HTTPS access to `api.github.com` and `codeload.github.com`.

---

## Installation

1. Download or clone this repository into your FiveM server's `resources` directory:
   ```
   [resources]/[LumaNode]/LNS_AutoUpdater/
   ```
2. Verify that the folder name is `LNS_AutoUpdater`.
3. Open `config.json` inside the `LNS_AutoUpdater` directory and configure your managed resources and settings.
4. Add the resource to your `server.cfg`:
   ```cfg
   ensure LNS_AutoUpdater
   ```
5. Configure ACE permissions in `server.cfg` (see [Permissions (ACE)](#permissions-ace)).
6. Start or restart your FXServer.

---

## Permissions (ACE)

`LNS_AutoUpdater` commands executed from in-game chat require an ACE permission check. When executed directly from the server console (txAdmin or server terminal), commands are always authorized.

By default, the required ACE permission is `command.update`.

### server.cfg Example

```cfg
# Grant the update command permission to the admin group
add_ace group.admin command.update allow

# Assign players or identifiers to the admin group
add_principal identifier.fivem:123456 group.admin
add_principal identifier.license:abcdef123456 group.admin
```

If you wish to change the permission node, modify `"adminAcePermission"` in `config.json`.

---

## Configuration Guide

The configuration file is located at `config.json` in the root of the resource.

### Root Configuration

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `checkIntervalMinutes` | number | `60` | Interval in minutes between automated GitHub checks. Set to `0` to disable periodic checks. |
| `backupConfigs` | boolean | `true` | When `true`, saves timestamped copies of existing config files before merging updates. |
| `autoRestartResource` | boolean | `false` | When `true`, automatically executes `restart <resourceName>` in FXServer after an update succeeds. |
| `adminAcePermission` | string | `"command.update"` | The ACE permission node required to use updater commands in-game. |
| `discordWebhook` | string \| null | `null` | Discord webhook URL for update notices. Set to `null` or leave empty to disable. |
| `githubToken` | string \| null | `null` | Optional GitHub Personal Access Token. Increases API rate limits from 60 to 5,000 requests per hour. |
| `managedScripts` | array | `[]` | List of resources to manage and monitor. |

### Managed Resource Configuration

Each entry in the `managedScripts` array represents a resource:

| Field | Type | Description |
| :--- | :--- | :--- |
| `resourceName` | string | Exact folder name of the resource on your server (e.g. `LNS_Housing`). |
| `githubRepo` | string | GitHub repository in `owner/repository` format (e.g. `LumaNodeStudios/LNS_Housing`). |
| `branch` | string | Git branch to track when `useReleases` is set to `false` (e.g. `main` or `master`). |
| `useReleases` | boolean | Set to `true` to track GitHub Releases. Set to `false` to track latest branch commits. |
| `autoUpdate` | boolean | Set to `true` to automatically apply updates on boot or interval checks. Set to `false` to notify only. |
| `subfolder` | string | Subdirectory inside the repository if the resource is not located at the repository root. Leave `""` for root. |
| `configFiles` | array of strings | Relative file paths of configuration files that should be protected by the merge engine. |
| `ignoreFiles` | array of strings | Glob patterns or filenames that should never be overwritten by updates (e.g. `.git*`, `README.md`). |

### Example `config.json`

```json
{
  "checkIntervalMinutes": 60,
  "backupConfigs": true,
  "autoRestartResource": false,
  "adminAcePermission": "command.update",
  "discordWebhook": "https://discord.com/api/webhooks/YOUR_WEBHOOK_URL",
  "githubToken": null,
  "managedScripts": [
    {
      "resourceName": "LNS_Housing",
      "githubRepo": "LumaNodeStudios/LNS_Housing",
      "branch": "main",
      "useReleases": true,
      "autoUpdate": false,
      "subfolder": "",
      "configFiles": [
        "shared/settings.lua",
        "shared/sv_settings.lua",
        "shared/furniture.lua"
      ],
      "ignoreFiles": [
        ".git*",
        ".github/*",
        "README.md",
        "LICENSE"
      ]
    },
    {
      "resourceName": "LNS_Fuel",
      "githubRepo": "LumaNodeStudios/LNS_Fuel",
      "branch": "main",
      "useReleases": true,
      "autoUpdate": true,
      "subfolder": "",
      "configFiles": [
        "shared/settings.lua"
      ],
      "ignoreFiles": []
    }
  ]
}
```

---

## Usage

### In-Game & Server Console Commands

These commands can be run from the server console or in-game chat (prefix with `/` when using chat):

#### 1. Check for Updates
Checks all managed scripts or a specific script for new versions:
```text
checkupdates
checkupdates <resourceName>
```
*Examples:*
- `checkupdates`
- `checkupdates LNS_Housing`

#### 2. Update a Specific Resource
Downloads the latest release or commit for the specified resource, merges configurations, and creates backups:
```text
update <resourceName>
```
*Example:*
- `update LNS_Housing`

#### 3. Update All Pending Resources
Scans all managed resources and applies updates to every resource that has a new version available:
```text
updateall
```

---

### Standalone Command Line Interface (CLI)

You can manage updates directly from PowerShell, Bash, or CI/CD scripts without starting FXServer by using `cli.js`:

```bash
# Display help and available commands
node cli.js --help

# Check all managed scripts for available updates
node cli.js --check
node cli.js -c

# Update a specific script
node cli.js --update <resourceName>
node cli.js -u <resourceName>

# Update all scripts that have updates available
node cli.js --update-all
node cli.js -a
```

---

### Lua / JS Exports

Other server-side scripts can trigger or query updates programmatically:

#### Check for Updates Export
```lua
local hasUpdate, latestInfo = exports['LNS_AutoUpdater']:CheckForUpdates('LNS_Housing')
if hasUpdate then
    print('Update available for LNS_Housing: ' .. latestInfo.ref)
end
```

#### Update Resource Export
```lua
exports['LNS_AutoUpdater']:UpdateResource('LNS_Housing')
```

---

## Smart Config Preservation

When an update is pulled, standard files (client scripts, server scripts, UI assets, manifests) are replaced with the incoming versions.

For any file listed in the `configFiles` array, the updater runs the **Smart Config Merger**:

### Lua Configuration Merging
1. The engine reads your local file and the upstream GitHub file.
2. It parses top-level assignments (such as `Config.Price = 500` or `Config.Settings = { ... }`).
3. If an option already exists in your local file, **your local value is preserved**.
4. If upstream introduces a new setting or a new sub-key inside a table, the new key and value are automatically injected into your configuration with explanatory comments.
5. Formatting, indentation, and custom logic in your local file are retained.

### JSON Configuration Merging
1. Recursively traverses the incoming JSON schema.
2. Injects any newly introduced keys that do not exist locally.
3. Retains all existing local values.

### Automated Backups
When `"backupConfigs": true` is enabled, a timestamped snapshot of every modified config is saved into `.updater_backups/` within the resource folder:
```
[resources]/[LumaNode]/LNS_Housing/
├── .updater_backups/
│   ├── settings.lua.2026-10-12T11-45-00-000Z.bak
│   └── sv_settings.lua.2026-10-12T11-45-00-000Z.bak
├── shared/
│   └── settings.lua
└── ...
```

---

## File Ignoring & Subfolders

### Ignoring Files
You can specify files or patterns in the `ignoreFiles` array of any managed script to ensure they are never overwritten or downloaded from GitHub:

- Wildcard directory ignore: `.github/*`
- Extension wildcard: `*.md`
- Prefix wildcard: `.git*`
- Exact file match: `README.md` or `LICENSE`

### Monorepo / Subfolder Repositories
If a GitHub repository contains multiple FiveM resources or stores the resource in a nested folder, use the `subfolder` property:

```json
{
  "resourceName": "my_resource",
  "githubRepo": "author/monorepo",
  "subfolder": "resources/my_resource"
}
```

The updater extracts only the contents of the specified subfolder directly into the target resource directory.