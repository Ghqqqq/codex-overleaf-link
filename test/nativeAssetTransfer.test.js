'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { syncOverleafToMirror, getProjectMirror } = require('../native-host/src/mirrorWorkspace');
const { prepareBinaryAssetChanges, readAssetChunk, releaseAsset } = require('../native-host/src/nativeAssetTransfer');

test('binary assets are exposed through bounded verified chunks', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-asset-'));
  try {
    await syncOverleafToMirror({
      projectId: 'asset-project', rootDir,
      project: { capabilities: { fullProjectSnapshot: true }, files: [] }
    });
    const mirror = getProjectMirror('asset-project', { rootDir });
    const bytes = crypto.randomBytes(420000);
    fs.writeFileSync(path.join(mirror.workspacePath, 'figure.pdf'), bytes);
    const prepared = prepareBinaryAssetChanges({
      projectId: 'asset-project', rootDir,
      changes: [{ type: 'binary-create', path: 'figure.pdf', assetSourcePath: 'figure.pdf', size: bytes.length }]
    });
    const ref = prepared.changes[0].assetRef;
    assert.equal(typeof ref.token, 'string');
    assert.equal(prepared.changes[0].contentBase64, undefined);
    const chunks = [];
    let offset = 0;
    while (offset < ref.size) {
      const chunk = readAssetChunk({ token: ref.token, offset });
      chunks.push(Buffer.from(chunk.contentBase64, 'base64'));
      offset = chunk.nextOffset;
    }
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(releaseAsset({ token: ref.token }).released, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

