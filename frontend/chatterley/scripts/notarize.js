const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { process.stdout.write(d); stdout += d; });
    if (child.stderr) child.stderr.on('data', (d) => { process.stderr.write(d); stderr += d; });
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} ${args.join(' ')} failed with code ${code}`);
      err.stdout = stdout; err.stderr = stderr; err.code = code;
      reject(err);
    });
  });
}

async function notarizeHook(context) {
  const { electronPlatformName, appOutDir } = context;
  const logDir = path.join(appOutDir, '..');
  const hookLog = path.join(logDir, 'NOTARIZE_HOOK.log');
  const log = (msg) => {
    try { fs.appendFileSync(hookLog, `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
    console.log(msg);
  };
  log(`🔔 afterSign hook: platform=${electronPlatformName} appOutDir=${appOutDir}`);
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    log(`❗ Expected app not found at: ${appPath}. Skipping notarization.`);
    return;
  }

  // Allow skipping notarization locally
  if (process.env.NOTARIZE === '0') {
    console.log('Skipping notarization because NOTARIZE=0');
    return;
  }

  const { APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID } = process.env;
  log(`[notarize] Env present: APPLE_ID=${APPLE_ID ? 'yes' : 'no'}, APPLE_TEAM_ID=${APPLE_TEAM_ID ? 'yes' : 'no'}, APPLE_ID_PASSWORD=${APPLE_ID_PASSWORD ? 'yes' : 'no'}`);
  if (!APPLE_ID || !APPLE_ID_PASSWORD || !APPLE_TEAM_ID) {
    log('Skipping notarization: Missing required environment variables');
    log('Set APPLE_ID, APPLE_ID_PASSWORD, and APPLE_TEAM_ID to enable notarization');
    return;
  }

  // Create a zip for submission (explicit for predictable name and progress logs)
  const zipPath = path.join(path.dirname(appOutDir), `${appName}-notary.zip`);
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    log(`📦 Compressing app with ditto → ${zipPath}`);
    await run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
    const stats = fs.statSync(zipPath);
    log(`📏 Zip size: ${(stats.size / (1024 * 1024)).toFixed(1)} MB`);
  } catch (e) {
    log('Failed to zip app for notarization');
    throw e;
  }

  // Submit with progress and wait for completion
  log('🚀 Submitting to Apple Notary Service (notarytool) with progress...');
  const submitArgs = [
    'notarytool', 'submit', zipPath,
    '--apple-id', APPLE_ID,
    '--password', APPLE_ID_PASSWORD,
    '--team-id', APPLE_TEAM_ID,
    '--wait', '--progress', '--output-format', 'json'
  ];

  try {
    const { stdout } = await run('xcrun', submitArgs);
    // stdout already streamed with progress; try to detect Accepted for a friendly message
    try {
      const lines = stdout.trim().split(/\n+/);
      const last = lines[lines.length - 1];
      if (last) {
        const parsed = JSON.parse(last);
        if (parsed && parsed.status) log(`📬 Notarization status: ${parsed.status}`);
      }
    } catch (_) {}
  } catch (err) {
    log('❌ Notarization failed via notarytool');
    throw err;
  }

  // Staple ticket
  log('📎 Stapling notarization ticket to app...');
  await run('xcrun', ['stapler', 'staple', appPath]);
  log('✅ Staple complete.');
}

module.exports = notarizeHook;
module.exports.default = notarizeHook;
