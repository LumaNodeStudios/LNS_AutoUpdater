fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'LumaNode Studios'
description 'LumaNode Studios - Automated GitHub resource updater'
version '1.0.0'

files {
    'config.json'
}

server_scripts {
    'server/sv_zip.js',
    'server/sv_merger.js',
    'server/sv_github.js',
    'server/sv_discord.js',
    'server/sv_utils.js',
    'server/sv_main.js'
}