#!/usr/bin/env node
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { installManagedDistribution } = require('../native-host/src/managedInstall.js');
const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), '..');

export function installManaged(options = {}) {
  return installManagedDistribution({ ...options, packageRoot: options.packageRoot || packageRoot });
}

export function formatInstallManagedHuman(result) {
  return [
    'Installed managed Codex Overleaf Link v' + result.version + '.',
    'Managed extension path: ' + result.extensionRoot,
    'Managed native root: ' + result.nativeRoot,
    'One-time Chrome step:',
    '1. Open chrome://extensions and enable Developer mode.',
    '2. Remove the previous Codex Overleaf Link entry if Chrome shows a duplicate.',
    '3. Choose Load unpacked and select: ' + result.loadUnpackedPath,
    'Future signed stable updates are checked automatically. Choose Update now to authorize a version; installation waits until Overleaf is saved and idle.',
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--extension-id') parsed.extensionId = readValue(argv, index++, arg);
    else if (arg === '--browser') parsed.browser = readValue(argv, index++, arg);
    else if (arg === '--managed-root') parsed.managedRoot = readValue(argv, index++, arg);
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help') parsed.help = true;
    else throw new Error('Unknown option: ' + arg);
  }
  return parsed;
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Missing value for ' + name);
  return value;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: install-managed [--extension-id <id>] [--browser chrome|chromium|auto] [--managed-root <path>] [--json]');
      return;
    }
    const result = installManaged(args);
    process.stdout.write(args.json ? JSON.stringify(result, null, 2) + '\n' : formatInstallManagedHuman(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] || '') === scriptPath) await main();
