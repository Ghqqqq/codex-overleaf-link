(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafTrackedChangeOwnership = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create({ fingerprint, readActiveEditorText, mergedPrefix, nativeKey, ledgerKeys }) {
    function parseNativeRef(ref) {
      try {
        if (!ref?.key?.startsWith('native:') || ref.key.length > 1024) return null;
        const tuple = JSON.parse(ref.key.slice(7));
        if (!Array.isArray(tuple) || tuple.length !== 5 || tuple[0] !== ref.id
          || typeof tuple[0] !== 'string' || !tuple[0] || tuple[0].length > 256
          || !['insert', 'delete'].includes(tuple[1])
          || !Number.isSafeInteger(tuple[2]) || !Number.isSafeInteger(tuple[3])
          || tuple[2] < 0 || tuple[3] < tuple[2]
          || (tuple[1] === 'delete' && tuple[2] !== tuple[3])
          || (tuple[1] === 'insert' && tuple[2] === tuple[3])
          || typeof tuple[4] !== 'string' || !/^\d+:[0-9a-f]+:[0-9a-f]+$/.test(tuple[4])) return null;
        return tuple;
      } catch (_error) { return null; }
    }

    // An existing ID can grow when a later insertion touches an older change.
    // Prove the entire ledger as old fragments + this run's inserted slices.
    // Never assign ownership of the whole merged ID.
    function mergedInsertionScope(capture, after, postContent) {
      if (capture?.source !== 'native' || !capture.nativeDocId || !capture.runProjectId
        || typeof postContent !== 'string' || fingerprint(postContent) !== capture.expected
        || !Array.isArray(capture.before) || !capture.before.length || capture.before.length > 128
        || !Array.isArray(after) || !after.length || after.length > 128
        || !Array.isArray(capture.ranges) || !capture.ranges.length || capture.ranges.length > 64) return null;
      const ranges = capture.ranges;
      let delta = 0, previousFrom = -1;
      for (const range of ranges) {
        if (!Number.isSafeInteger(range.from) || range.from <= previousFrom || range.to !== range.from
          || range.removedLength !== 0 || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
          || range.start !== range.from + delta || range.end <= range.start || range.end > postContent.length) return null;
        delta += range.end - range.start;
        previousFrom = range.from;
      }
      let preContent = postContent;
      for (const range of ranges.slice().reverse()) {
        preContent = preContent.slice(0, range.start) + preContent.slice(range.end);
      }
      const before = capture.before.map(parseNativeRef);
      if (before.some(tuple => !tuple)) return null;
      const beforeKeys = before.map(nativeKey).sort();
      if (new Set(beforeKeys).size !== beforeKeys.length) return null;
      const preservedKeys = [];
      for (const tuple of before) {
        const [id, kind, from, to, hash] = tuple;
        if (to > preContent.length
          || (kind === 'insert' && fingerprint(preContent.slice(from, to)) !== hash)) return null;
        // Interior edits and deletion-boundary ambiguity need a different proof.
        if (ranges.some(range => kind === 'insert'
          ? range.from > from && range.from < to : range.from === from)) return null;
        const startShift = ranges.filter(range => range.from <= from)
          .reduce((sum, range) => sum + range.end - range.start, 0);
        const endShift = kind === 'delete' ? startShift : ranges.filter(range => range.from < to)
          .reduce((sum, range) => sum + range.end - range.start, 0);
        preservedKeys.push(nativeKey([id, kind, from + startShift, to + endShift, hash]));
      }
      preservedKeys.sort();
      const oldIds = new Set(before.map(tuple => tuple[0]));
      const mergedIds = new Set(), residue = [], claims = ranges.map(() => []);
      for (const ref of after) {
        const tuple = parseNativeRef(ref);
        if (!tuple || ref.path !== capture.path) return null;
        const [id, kind, from, to, hash] = tuple;
        if (kind === 'delete') { residue.push(nativeKey(tuple)); continue; }
        if (to > postContent.length || fingerprint(postContent.slice(from, to)) !== hash) return null;
        let pieces = [[from, to]];
        ranges.forEach((range, index) => {
          const start = Math.max(from, range.start), end = Math.min(to, range.end);
          if (start >= end) return;
          claims[index].push([start, end]);
          if (oldIds.has(id)) mergedIds.add(id);
          pieces = pieces.flatMap(([left, right]) => {
            if (range.end <= left || range.start >= right) return [[left, right]];
            const remaining = [];
            if (left < range.start) remaining.push([left, range.start]);
            if (range.end < right) remaining.push([range.end, right]);
            return remaining;
          });
        });
        for (const [left, right] of pieces) {
          residue.push(nativeKey([id, kind, left, right, fingerprint(postContent.slice(left, right))]));
        }
      }
      if (!mergedIds.size || JSON.stringify(residue.sort()) !== JSON.stringify(preservedKeys)) return null;
      for (let index = 0; index < ranges.length; index++) {
        let cursor = ranges[index].start;
        for (const [start, end] of claims[index].sort((a, b) => a[0] - b[0])) {
          if (start !== cursor) return null;
          cursor = end;
        }
        if (cursor !== ranges[index].end) return null;
      }
      const proof = [1, capture.runProjectId, capture.nativeDocId, fingerprint(preContent),
        capture.expected, beforeKeys, ranges.map(range => [range.from, range.start, range.end]),
        fingerprint(JSON.stringify(ledgerKeys(after)))];
      const key = mergedPrefix + JSON.stringify(proof);
      if (key.length > 32768) return null;
      return {
        ref: { key, id: [...mergedIds].sort()[0], path: capture.path,
          label: 'This run: insertion merged with an earlier tracked change' },
        runProjectId: capture.runProjectId, beforeKeys, preservedKeys, ranges, preContent, postContent
      };
    }

    function prepareMergedInsertionReview(path, targets, snapshot) {
      const blocked = reason => ({ ...snapshot, ok: false, reason });
      if (targets.length !== 1 || !snapshot.acceptByIdSupported) return blocked('native_merged_review_unsupported');
      const target = targets[0];
      try {
        if (target.key.length > 32768) return blocked('native_merged_review_invalid');
        const proof = JSON.parse(target.key.slice(mergedPrefix.length));
        if (!Array.isArray(proof) || proof.length !== 8 || proof[0] !== 1
          || proof[2] !== snapshot.nativeDocId || !Array.isArray(proof[5]) || proof[5].length > 128
          || !Array.isArray(proof[6]) || proof[6].length > 64) return blocked('native_merged_review_invalid');
        const before = proof[5].map(key => {
          const tuple = JSON.parse(key.slice(7));
          return { key, id: tuple[0], path };
        });
        const ranges = proof[6].map(([from, start, end]) => ({
          from, to: from, start, end, removedLength: 0
        }));
        const merged = mergedInsertionScope({ source: 'native', path, runProjectId: proof[1],
          nativeDocId: proof[2], expected: proof[4], before, ranges }, snapshot.refs, readActiveEditorText());
        if (!merged || merged.ref.key !== target.key || merged.ref.id !== target.id)
          return blocked('native_merged_review_scope_changed');
        return { ...snapshot, ok: true, targets, ids: [], unrelated: snapshot.refs, merged };
      } catch (_error) { return blocked('native_merged_review_invalid'); }
    }

    function nativeOwned(ref, capture) {
      if (ref.source !== 'native' || !Number.isSafeInteger(ref.from) || !Number.isSafeInteger(ref.to)) return false;
      if (ref.kind === 'delete') return capture.ranges.some(range => ref.from >= range.start && ref.from <= range.end
        && ref.textLength === range.removedLength && ref.textHash === range.removedHash && range.removedLength > 0);
      let covered = ref.from;
      for (const range of capture.ranges) {
        if (range.end < covered) continue;
        if (range.start > covered) break;
        covered = Math.max(covered, range.end);
        if (covered >= ref.to) return ref.to > ref.from;
      }
      return false;
    }

    function rangesFor(operation, beforeContent, postContent) {
      const patches = Array.isArray(operation.patches) && operation.patches.length
        ? operation.patches
        : [{ from: 0, to: beforeContent.length, insert: postContent }];
      let delta = 0;
      return patches.map(patch => {
        const range = { from: patch.from, to: patch.to,
          start: patch.from + delta, end: patch.from + delta + String(patch.insert ?? '').length,
          removedLength: patch.to - patch.from, removedHash: fingerprint(beforeContent.slice(patch.from, patch.to)) };
        delta += String(patch.insert ?? '').length - (patch.to - patch.from);
        return range;
      });
    }

    function shiftedBaseline(before, ranges) {
      let overlap = false;
      const refs = before.map(ref => {
        const match = /^pos:(\d+):/.exec(ref.key);
        if (!match) return ref;
        const pos = Number(match[1]);
        let delta = 0;
        for (const range of ranges) {
          if (pos >= range.from && pos < range.to) overlap = true;
          if (pos >= range.to) delta += (range.end - range.start) - (range.to - range.from);
        }
        return { ...ref, key: ref.key.replace(/^pos:\d+:/, 'pos:' + (pos + delta) + ':') };
      });
      return { refs, overlap };
    }

    function scopeCovered(refs, capture) {
      if (refs.length === 1 && refs[0].key?.startsWith(mergedPrefix)) return true;
      if (capture.source === 'native') return capture.ranges.every(range => refs.some(ref =>
        ref.from <= range.end && ref.to >= range.start));
      const positioned = refs.filter(ref => /^pos:\d+:/.test(ref.key));
      if (refs.some(ref => ref.id)) return true;
      return capture.ranges.every(range => positioned.some(ref => {
        const pos = Number(/^pos:(\d+):/.exec(ref.key)[1]);
        return pos >= range.start && pos <= range.end;
      }));
    }

    return { mergedInsertionScope, prepareMergedInsertionReview, nativeOwned, rangesFor, shiftedBaseline, scopeCovered };
  }

  return { create };
});
