/**
 * Script to clear Python cache files before building Electron app
 * 
 * This helps prevent stale .pyc files and __pycache__ directories from causing 
 * issues with loading updated Python modules.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get the oumi package root directory
const getOumiRootPath = () => {
  // New layout: repo/frontend/chatterley/scripts -> repo/backend/oumi
  const repoRoot = path.resolve(__dirname, '../../..');
  const backendPath = path.join(repoRoot, 'backend', 'oumi');

  if (fs.existsSync(backendPath)) {
    return backendPath;
  }

  // Fallback for legacy layout where backend lived next to frontend
  const legacyPath = path.resolve(__dirname, '../../');
  if (fs.existsSync(path.join(legacyPath, 'configs'))) {
    return legacyPath;
  }

  throw new Error('Unable to resolve Oumi backend root. Expected backend/oumi in repository.');
};

// Clear Python cache
const clearPythonCache = () => {
  try {
    const oumiRoot = getOumiRootPath();
    console.log(`Clearing Python cache in: ${oumiRoot}`);
    
    // Commands to run
    const commands = [
      // Find and delete .pyc files
      `find "${oumiRoot}" -name "*.pyc" -delete`,
      // Find and delete __pycache__ directories
      `find "${oumiRoot}" -name "__pycache__" -type d -exec rm -rf {} +`
    ];
    
    // Execute commands
    commands.forEach(cmd => {
      try {
        execSync(cmd, { stdio: 'inherit' });
      } catch (error) {
        // Some find commands may fail if permissions are denied or paths don't exist
        // Just continue with the process
        console.log(`Warning: Command had non-zero exit: ${cmd}`);
      }
    });
    
    // Remove common heavy cache directories if present
    const heavyDirs = [
      '.cache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
      '.venv', 'venv', 'env', 'node_modules'
    ];
    heavyDirs.forEach((dir) => {
      try {
        const p = path.join(oumiRoot, dir);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
          console.log(`Removed heavy cache directory: ${p}`);
        }
      } catch (e) {
        console.log(`Warning: failed to remove ${dir}:`, e?.message || e);
      }
    });

    console.log('Python caches cleared and heavy directories pruned.');
  } catch (error) {
    console.error('Error clearing Python cache:', error);
    process.exit(1);
  }
};

// Run the script
clearPythonCache();
