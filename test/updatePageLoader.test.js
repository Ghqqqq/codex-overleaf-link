const assert = require('node:assert/strict');
const test = require('node:test');

const Loader = require('../extension/bootstrap/updateLoader');

test('update page resolves the projection from the active extension layout', () => {
  assert.equal(
    Loader.resolveProjectionPath('src/background.js'),
    '../src/shared/managedUpdateProjection.js'
  );
  assert.equal(
    Loader.resolveProjectionPath('bootstrap/background.js'),
    '../runtime/src/shared/managedUpdateProjection.js'
  );
});

test('update page loads its projection before the controller', async () => {
  const loaded = [];
  await Loader.loadForWorker('src/background.js', async source => {
    loaded.push(source);
  });

  assert.deepEqual(loaded, [
    '../src/shared/managedUpdateProjection.js',
    'update.js'
  ]);
});

test('projection load failure prevents a partially initialized update controller', async () => {
  const loaded = [];
  await assert.rejects(
    Loader.loadForWorker('bootstrap/background.js', async source => {
      loaded.push(source);
      throw new Error('missing projection');
    }),
    /missing projection/
  );
  assert.deepEqual(loaded, ['../runtime/src/shared/managedUpdateProjection.js']);
});
