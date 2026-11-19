#!/usr/bin/env node
/**
 * Copy the built plugin into the desktop app's plugin root.
 *
 * The loader reads exactly `<hermes home>/desktop-plugins/<id>/plugin.js`
 * (default profile shown; set HERMES_HOME to install elsewhere). It fs-watches
 * that path, so a copy is a live reload — no app restart.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const built = join(here, '..', 'build', 'plugin.js')

if (!existsSync(built)) {
  console.error(`no build at ${built} — run: npm run build`)
  process.exit(1)
}

const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const target = join(home, 'desktop-plugins', 'element-edit', 'plugin.js')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(built, target)

const kb = (statSync(target).size / 1024).toFixed(1)
console.log(`installed ${built} -> ${target} (${kb} KB)`)
