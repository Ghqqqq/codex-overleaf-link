const assert = require('node:assert/strict');
const test = require('node:test');

const QueuePolicy = require('../extension/src/shared/scopedPersistenceQueuePolicy');

function claimAs(ownerId) {
  const result = QueuePolicy.applyQueueMutations({}, [{
    type: 'claim',
    itemId: 'queue-1',
    sessionId: 'session-1',
    claimToken: 'claim-a'
  }], ownerId);
  assert.equal(result.ok, true);
  return result.meta;
}

for (const type of ['release', 'restore', 'remove']) {
  test(`${type} rejects a foreign queue claim`, () => {
    const claimed = claimAs('writer-a');
    const result = QueuePolicy.applyQueueMutations(claimed, [{
      type,
      itemId: 'queue-1',
      claimToken: 'claim-a'
    }], 'writer-b');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'queue_claim_conflict');
    assert.equal(result.ownerId, 'writer-a');
    assert.equal(claimed.queueClaims['queue-1'].claimToken, 'claim-a');
  });

  test(`${type} rejects the claim owner when its token is missing or stale`, () => {
    const claimed = claimAs('writer-a');
    for (const claimToken of ['', 'claim-stale']) {
      const result = QueuePolicy.applyQueueMutations(claimed, [{
        type,
        itemId: 'queue-1',
        claimToken
      }], 'writer-a');

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'queue_claim_conflict');
      assert.equal(result.ownerId, 'writer-a');
      assert.equal(claimed.queueClaims['queue-1'].claimToken, 'claim-a');
    }
  });
}

test('claim owner can release its own queue item with the matching token', () => {
  const claimed = claimAs('writer-a');
  const result = QueuePolicy.applyQueueMutations(claimed, [{
    type: 'release',
    itemId: 'queue-1',
    claimToken: 'claim-a'
  }], 'writer-a');

  assert.equal(result.ok, true);
  assert.equal(result.meta.queueClaims['queue-1'], undefined);
});
