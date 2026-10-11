'use strict';

// The signed Bootstrap revision migration targets the published 2.5.1 release.
// Later checkouts keep identical Bootstrap bytes, but their manifest template
// carries the current package version. Tests of the historical migration read
// this materialized 2.5.1 package instead of the live checkout.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '../..');
const MIGRATION_TARGET_VERSION = '2.5.1';
let packageRoot = '';

function migrationTemplate() {
  const template = JSON.parse(fs.readFileSync(path.join(repo, 'extension/bootstrap/manifest.template.json'), 'utf8'));
  return { ...template, version: MIGRATION_TARGET_VERSION };
}

function migrationPackageRoot() {
  if (packageRoot && fs.existsSync(packageRoot)) return packageRoot;
  packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'col-bootstrap-2.5.1-'));
  process.once('exit', () => fs.rmSync(packageRoot, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'extension/bootstrap'), path.join(packageRoot, 'extension/bootstrap'), { recursive: true });
  writeMigrationTemplate(path.join(packageRoot, 'extension/bootstrap/manifest.template.json'));
  return packageRoot;
}

function writeMigrationTemplate(filename) {
  fs.writeFileSync(filename, JSON.stringify(migrationTemplate(), null, 2) + '\n');
}

module.exports = { MIGRATION_TARGET_VERSION, migrationPackageRoot, migrationTemplate, writeMigrationTemplate };
