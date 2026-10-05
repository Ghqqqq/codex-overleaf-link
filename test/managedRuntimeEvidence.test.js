'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { managedFixture } = require('./helpers/managedUpdateFixture');

test('runtime byte evidence is identical across Native process locales', t => {
  const f = managedFixture(t); f.install('2.5.0');
  const runtime = path.join(f.context.extensionRoot, 'runtime');
  fs.writeFileSync(path.join(runtime, 'I-uppercase-witness.txt'), 'same bytes');
  fs.writeFileSync(path.join(runtime, 'i-lowercase-witness.txt'), 'same bytes');
  const reader = `const m=require(process.argv[1]);const context=JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({locale:new Intl.Collator().resolvedOptions().locale,
evidence:m.readManagedRuntimeEvidence(context,'2.5.0')}));`;
  const results = ['tr_TR.UTF-8', 'en_US.UTF-8'].map(locale => {
    const result = spawnSync(process.execPath, ['-e', reader,
      path.resolve(__dirname, '../native-host/src/managedRuntimeEvidence.js'), JSON.stringify(f.context)],
    { env: { ...f.env, LANG: locale, LC_ALL: locale }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  if (process.platform !== 'win32') assert.notEqual(results[0].locale, results[1].locale);
  assert.deepEqual(results[0].evidence, results[1].evidence);
});
