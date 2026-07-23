'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const StorageMigration = require('../extension/src/shared/storageMigration');

test('concurrent tabs retain independent session tombstones', async () => {
  const previousChrome = global.chrome;
  const stored = {};
  let synchronizedReads = 0;
  let waitingReaders = [];

  global.chrome = {
    storage: {
      local: {
        get: async keys => {
          if (keys !== null || synchronizedReads >= 2) {
            return selectStored(stored, keys);
          }
          synchronizedReads += 1;
          return new Promise(resolve => {
            waitingReaders.push(() => resolve(selectStored(stored, keys)));
            if (waitingReaders.length === 2) {
              const readers = waitingReaders;
              waitingReaders = [];
              readers.forEach(reader => reader());
            }
          });
        },
        set: async payload => {
          Object.assign(stored, structuredClone(payload));
        },
        remove: async keys => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
        }
      }
    }
  };

  try {
    await Promise.all([
      StorageMigration.addSessionTombstones('project-1', ['session-a']),
      StorageMigration.addSessionTombstones('project-1', ['session-b'])
    ]);
    const tombstones = await StorageMigration.loadSessionTombstones();
    assert.deepEqual(new Set(tombstones['project-1']), new Set(['session-a', 'session-b']));
  } finally {
    global.chrome = previousChrome;
  }
});

function selectStored(stored, keys) {
  if (keys === null || keys === undefined) return structuredClone(stored);
  const result = {};
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) result[key] = structuredClone(stored[key]);
  }
  return result;
}
