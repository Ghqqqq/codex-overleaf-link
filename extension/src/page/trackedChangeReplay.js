(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafTrackedChangeReplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create({ normalizeSafeProjectPath, applyTextPatches }) {
  // Builds the minimal replay operations for Accept All. The replay must write
  // only the changed fragments, never a whole-file replaceAll.
  //
  // Preferred source: the run's own original forward writeback operations
  // (carrying their `patches`). After the editor-undo the document is back at
  // the pre-write content, so those patches' `expected` slices match and
  // re-apply cleanly.
  //
  // Fallback: when a path has no usable original patch operation, compute a
  // minimal pre->post diff (trim the common prefix/suffix to a single targeted
  // {from,to,insert} patch).
  function buildAcceptReplayOperations(paths, expectedByPath, postByPath, appliedOperations) {
    const patchesByPath = collectAppliedEditPatchesByPath(appliedOperations);
    const operations = [];
    for (const path of paths) {
      const preContent = expectedByPath.get(path);
      const postContent = postByPath.get(path);
      if (typeof preContent !== 'string' || typeof postContent !== 'string') {
        return {
          ok: false,
          code: 'accept_missing_run_content',
          reason: `${path} 缺少写入前/写入后内容；Codex 没有重放本轮改动。`
        };
      }

      // Preferred: re-apply the run's original forward patches verbatim.
      const originalPatches = patchesByPath.get(path);
      if (originalPatches && originalPatches.length && patchesApplyCleanly(preContent, originalPatches)) {
        operations.push({
          type: 'edit',
          path,
          patches: originalPatches,
          reason: 'Accept tracked edit (replay untracked)'
        });
        continue;
      }

      // Fallback: minimal pre->post diff trimmed to a single targeted patch.
      const diffPatch = buildMinimalDiffPatch(preContent, postContent);
      if (!diffPatch) {
        // pre === post: nothing to replay for this file.
        continue;
      }
      operations.push({
        type: 'edit',
        path,
        patches: [diffPatch],
        reason: 'Accept tracked edit (replay untracked)'
      });
    }
    return { ok: true, operations };
  }

  // Collects the per-path `patches` arrays from the run's applied edit
  // operations. Only edit operations that actually carried `patches` are
  // usable; whole-file replaceAll / verifiedContent operations are skipped so
  // the replay never falls back to a whole-file write.
  function collectAppliedEditPatchesByPath(appliedOperations) {
    const patchesByPath = new Map();
    for (const rawOperation of Array.isArray(appliedOperations) ? appliedOperations : []) {
      if (!rawOperation || rawOperation.type !== 'edit') {
        continue;
      }
      const path = typeof rawOperation.path === 'string'
        ? normalizeSafeProjectPath(rawOperation.path)
        : '';
      if (!path || !Array.isArray(rawOperation.patches) || !rawOperation.patches.length) {
        continue;
      }
      const normalized = rawOperation.patches.map(patch => ({
        from: Number(patch?.from),
        to: Number(patch?.to),
        expected: String(patch?.expected ?? ''),
        insert: String(patch?.insert ?? '')
      }));
      const existing = patchesByPath.get(path) || [];
      patchesByPath.set(path, existing.concat(normalized));
    }
    return patchesByPath;
  }

  // Confirms a patch set re-applies cleanly against the given (pre-write) text:
  // every patch range is valid and its `expected` slice matches.
  function patchesApplyCleanly(text, patches) {
    const applied = applyTextPatches(text, patches);
    return applied.ok === true;
  }

  // Computes a single targeted {from,to,insert} patch describing the pre->post
  // change by trimming the common prefix and suffix. Returns null when the two
  // strings are identical.
  function buildMinimalDiffPatch(preContent, postContent) {
    if (preContent === postContent) {
      return null;
    }
    const preLen = preContent.length;
    const postLen = postContent.length;
    let prefix = 0;
    const maxPrefix = Math.min(preLen, postLen);
    while (prefix < maxPrefix && preContent[prefix] === postContent[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    const maxSuffix = Math.min(preLen, postLen) - prefix;
    while (
      suffix < maxSuffix
      && preContent[preLen - 1 - suffix] === postContent[postLen - 1 - suffix]
    ) {
      suffix += 1;
    }
    const from = prefix;
    const to = preLen - suffix;
    return {
      from,
      to,
      expected: preContent.slice(from, to),
      insert: postContent.slice(from, postLen - suffix)
    };
  }

  function rebaseCheckpointPair(actualContent, expectedContent, postContent) {
    const actual = String(actualContent ?? '');
    const expected = String(expectedContent ?? '');
    const post = String(postContent ?? '');
    if (actual === post) {
      return {
        ok: true,
        expectedContent: expected,
        postContent: post,
        prefixLength: 0,
        suffixLength: 0
      };
    }
    if (!post) {
      return { ok: false };
    }
    const matchIndex = actual.indexOf(post);
    if (matchIndex < 0 || actual.indexOf(post, matchIndex + 1) >= 0) {
      return { ok: false };
    }
    const prefix = actual.slice(0, matchIndex);
    const suffix = actual.slice(matchIndex + post.length);
    return {
      ok: true,
      expectedContent: prefix + expected + suffix,
      postContent: actual,
      prefixLength: prefix.length,
      suffixLength: suffix.length
    };
  }

    return { buildAcceptReplayOperations, rebaseCheckpointPair };
  }

  return { create };
});
