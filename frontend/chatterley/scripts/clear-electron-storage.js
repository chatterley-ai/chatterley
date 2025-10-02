#!/usr/bin/env node
/*
 * Clear temporary app storage keys prior to debug builds.
 * Targets the Electron-side persistent store (electron-store: ipc-config.json).
 * Keys cleared:
 *  - selectedConfig
 *  - lastSuccessfulModelTest
 *  - enableWelcomeCaching (temp)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveBase() {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  // linux and others
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function clearKeys(filePath, keys) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text || text.trim().length === 0) return false;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.warn(`[storage] Skipping corrupt JSON: ${filePath}`);
      return false;
    }

    let changed = false;
    for (const k of keys) {
      if (k in json) {
        delete json[k];
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
      console.log(`[storage] Cleared keys [${keys.join(', ')}] in ${filePath}`);
    } else {
      console.log(`[storage] No target keys found in ${filePath}`);
    }
    return changed;
  } catch (e) {
    console.warn(`[storage] Failed to process ${filePath}: ${e.message}`);
    return false;
  }
}

function main() {
  const base = resolveBase();
  const apps = ['Electron', 'Chatterley']; // Dev vs packaged userData roots
  const storeName = 'ipc-config.json';
  const keysToClear = ['selectedConfig', 'lastSuccessfulModelTest', 'enableWelcomeCaching'];

  console.log(`[storage] userData base: ${base}`);
  for (const app of apps) {
    const filePath = path.join(base, app, storeName);
    clearKeys(filePath, keysToClear);
  }
}

main();

