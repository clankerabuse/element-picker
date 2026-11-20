#!/usr/bin/env node
/**
 * Sync the built `plugin.js` to every plug-and-play entry point:
 *   1. `<repo>/plugin.js` & `<repo>/desktop/plugin.js` — so Hermes Desktop's
 *      Git installer (`clankerabuse/element-picker`), `hermes://plugin/install`,
 *      or a symlink into `~/.hermes/plugins/` works out of the box with zero
 *      build step for end users.
 *   2. `<HERMES_HOME>/desktop-plugins/element-edit/plugin.js` — live reload
 *      in the local Hermes Desktop app.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const repoRoot = join(pluginRoot, '..')
const built = join(pluginRoot, 'build', 'plugin.js')

if (!existsSync(built)) {
  console.error(`no build at ${built} — run: npm run build`)
  process.exit(1)
}

// 1. Keep repo-root `plugin.js` and `desktop/plugin.js` in sync for plug-and-play Git installs
const rootEntry = join(repoRoot, 'plugin.js')
const desktopDirEntry = join(repoRoot, 'desktop', 'plugin.js')
mkdirSync(dirname(desktopDirEntry), { recursive: true })
copyFileSync(built, rootEntry)
copyFileSync(built, desktopDirEntry)

// 2. Install into the local Hermes Desktop app's runtime plugin directory
const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const target = join(home, 'desktop-plugins', 'element-edit', 'plugin.js')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(built, target)

const kb = (statSync(target).size / 1024).toFixed(1)
console.log(`synced -> ${rootEntry}, ${desktopDirEntry}`)
console.log(`installed -> ${target} (${kb} KB)`)
