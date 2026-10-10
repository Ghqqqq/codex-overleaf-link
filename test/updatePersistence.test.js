'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { bootstrapMigrationFixture } = require('./helpers/bootstrapMigrationFixture');

// Model FlushFileBuffers' writable-handle requirement without replacing the
// updater, transaction storage, signed archive or migration state machine.
function trackedIo() {
  const handles = new Map();
  const flushedFiles = [];
  let failFile = null;
  let directoryError = '';
  const io = { ...fs,
    openSync(filename, flags, mode) {
      if (directoryError && fs.existsSync(filename) && fs.statSync(filename).isDirectory()) {
        throw Object.assign(new Error(directoryError + ': directory fsync'), { code: directoryError });
      }
      const fd = fs.openSync(filename, flags, mode);
      handles.set(fd, { filename, flags });
      return fd;
    },
    closeSync(fd) {
      try { return fs.closeSync(fd); } finally { handles.delete(fd); }
    },
    fsyncSync(fd) {
      const handle = handles.get(fd);
      assert.ok(handle, 'every flush uses an owned descriptor');
      if (fs.fstatSync(fd).isDirectory()) {
        if (directoryError) throw Object.assign(new Error(directoryError + ': directory fsync'), { code: directoryError });
      } else {
        const writable = typeof handle.flags === 'number'
          ? Boolean(handle.flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))
          : /[wa+]/.test(handle.flags);
        if (!writable) throw Object.assign(new Error('EPERM: operation not permitted, fsync (read-only file)'), { code: 'EPERM' });
        const code = failFile?.(handle.filename);
        if (code) throw Object.assign(new Error(code + ': file fsync'), { code });
        flushedFiles.push(handle.filename);
      }
      return fs.fsyncSync(fd);
    }
  };
  return { io, handles, flushedFiles,
    failFile(callback) { failFile = callback; },
    failDirectory(code) { directoryError = code; }
  };
}

test('signed update completes check, authorization, stage, apply and health with Windows-compatible file flushes', async t => {
  const tracked = trackedIo();
  const f = bootstrapMigrationFixture(t, { updateFs: tracked.io });
  await f.apply();
  assert.equal(f.journal().state, 'bootstrap_pending');
  await f.migrate();
  await f.migrate('3.1');
  assert.deepEqual(await f.confirm(), { version: '2.5.1', state: 'committed' });
  for (const name of ['candidate.json', 'authorization.json', 'transaction.json', 'active-version']) {
    assert.ok(tracked.flushedFiles.some(filename => path.basename(filename).startsWith(name + '.tmp-')), name);
  }
  assert.equal(tracked.handles.size, 0, 'all opened handles are closed');
});

test('ordinary file flush failures preserve prior authorization and remain errors on every platform', async t => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'EBADF', 'EIO']) {
    await t.test(code, async tt => {
      const tracked = trackedIo();
      const f = bootstrapMigrationFixture(tt, { updateFs: tracked.io });
      await f.request('update.check');
      const params = { authorizationId: crypto.randomUUID(), targetVersion: '2.5.1', currentVersion: '2.5.0' };
      await f.request('update.authorize', params);
      const target = path.join(f.context.updatesRoot, 'authorization.json');
      const before = fs.readFileSync(target);
      tracked.failFile(filename => path.basename(filename).startsWith('authorization.json.tmp-') ? code : '');
      const result = await f.response('update.revoke', params);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'update_internal_error');
      assert.match(result.error.message, new RegExp(code + ': file fsync'));
      assert.deepEqual(fs.readFileSync(target), before, 'unflushed bytes cannot replace the prior record');
      assert.equal(tracked.handles.size, 0, 'a failed flush also closes its file handle');
    });
  }
});

test('directory flush compatibility stays limited to Windows and its existing unsupported-operation errors', async t => {
  for (const code of ['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'EACCES', 'EIO']) {
    await t.test(code, async tt => {
      const tracked = trackedIo();
      const f = bootstrapMigrationFixture(tt, { updateFs: tracked.io });
      tracked.failDirectory(code);
      const result = await f.response('update.check');
      assert.equal(result.ok, process.platform === 'win32' && code !== 'EIO');
      if (!result.ok) assert.match(result.error.message, new RegExp(code + ': directory fsync'));
      assert.equal(tracked.handles.size, 0);
    });
  }
});
