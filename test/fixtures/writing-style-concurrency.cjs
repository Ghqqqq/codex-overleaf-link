'use strict';
const fs = require('node:fs'), path = require('node:path');
const { environment, params, model, scope, Style } = require('../_helpers/writingStyleFixture');
const [root, mode] = process.argv.slice(2), env = environment(root);
const barrier = name => {
  fs.writeFileSync(path.join(root, name + '.ready'), String(process.pid));
  const end = Date.now() + 8000;
  while (!fs.existsSync(path.join(root, name + '.release'))) {
    if (Date.now() > end) throw new Error('Fixture barrier timeout');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
(async () => {
  if (mode === 'lock-rename-denied') {
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (path.basename(to) === '.config-lock' && !fs.existsSync(to)) throw Object.assign(new Error('synthetic lock rename denied'), { code: 'EPERM' });
      return rename.apply(this, arguments);
    };
    require('node:assert/strict').throws(() => Style.set({ ...scope, enabled: false }, env), { code: 'EPERM' });
    return;
  }
  if (mode === 'disable') {
    fs.writeFileSync(path.join(root, 'disable.started'), String(process.pid));
    const result = Style.set({ ...scope, enabled: false }, env);
    fs.writeFileSync(path.join(root, 'disable.done'), JSON.stringify(result));
    return;
  }
  if (mode === 'publish') {
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (path.basename(from) === 'bundle' && path.basename(path.dirname(to)) === 'versions') barrier('publish');
      return rename.apply(this, arguments);
    };
  }
  await Style.build({ params: params(), env, execute: async input => { if (mode === 'model') barrier('model'); return model(input); } });
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
