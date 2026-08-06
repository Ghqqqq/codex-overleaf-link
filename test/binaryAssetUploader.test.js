'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  chooseOverleafFileInput,
  formatUploadHttpError,
  joinChunks,
  normalizePath
} = require('../extension/src/page/binaryAssetUploader');

test('page asset staging joins ordered chunks and rejects unsafe project paths', () => {
  assert.deepEqual(Array.from(joinChunks([Uint8Array.from([1, 2]), Uint8Array.from([3])], 3)), [1, 2, 3]);
  assert.equal(normalizePath('figures/result.pdf'), 'figures/result.pdf');
  assert.throws(() => normalizePath('../secret.pdf'));
});

test('binary upload targets the Overleaf Uppy input instead of the Codex composer attachment input', () => {
  const composerInput = fakeInput({ codexOwned: true, className: 'codex-composer-attachment-input' });
  const unrelatedInput = fakeInput({ className: 'avatar-upload' });
  const overleafInput = fakeInput({ className: 'uppy-Dashboard-input', inUppy: true, multiple: true });

  assert.equal(
    chooseOverleafFileInput([composerInput, unrelatedInput, overleafInput]),
    overleafInput
  );
});

test('binary upload diagnostics retain a bounded JSON reason for HTTP 422 responses', () => {
  assert.equal(
    formatUploadHttpError(422, JSON.stringify({ error: { message: 'folder_id is invalid' } })),
    'Overleaf upload endpoint returned HTTP 422 (folder_id is invalid).'
  );
  assert.equal(formatUploadHttpError(422, '<html>private error page</html>'), 'Overleaf upload endpoint returned HTTP 422.');
});

function fakeInput(options = {}) {
  return {
    className: options.className || '',
    disabled: options.disabled === true,
    isConnected: true,
    multiple: options.multiple === true,
    getAttribute() { return ''; },
    closest(selector) {
      if (options.codexOwned && selector.includes('#codex-overleaf-panel')) return {};
      if (options.inUppy && selector.includes('.uppy-Dashboard')) return {};
      return null;
    }
  };
}
