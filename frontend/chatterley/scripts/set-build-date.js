#!/usr/bin/env node

/**
 * Set build date in build-info.ts
 * This script replaces __BUILD_DATE__ with the current date/time
 */

const fs = require('fs');
const path = require('path');

const buildInfoPath = path.join(__dirname, '../src/lib/build-info.ts');

// Format date as YYYY-MM-DD
const buildDate = new Date().toISOString().split('T')[0];

// Read the file
let content = fs.readFileSync(buildInfoPath, 'utf8');

// Replace the placeholder
content = content.replace('__BUILD_DATE__', buildDate);

// Write it back
fs.writeFileSync(buildInfoPath, content, 'utf8');

console.log(`✓ Build date set to: ${buildDate}`);
