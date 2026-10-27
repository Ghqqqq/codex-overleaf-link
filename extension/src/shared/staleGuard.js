(function initStaleGuard(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafStaleGuard = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function staleGuardFactory() {
  'use strict';

  const DOCUMENT_PROVENANCE_OTHER_MIN = 0.9;
  const DOCUMENT_PROVENANCE_CLAIMED_MAX = 0.5;
  const DOCUMENT_PROVENANCE_EDGE_LIMIT = 64 * 1024;

  function assessDocumentProvenance(input = {}) {
    try {
      const { path, text, references } = input || {};
      if (typeof text !== 'string' || !references) return { ok: true };
      const entries = references instanceof Map ? references : Object.entries(references);
      const claimed = references instanceof Map ? references.get(path)
        : Object.prototype.hasOwnProperty.call(references, path) ? references[path] : undefined;
      if (text === claimed) return { ok: true };
      let matchedPath, bestScore = -1;
      for (const [otherPath, reference] of entries) {
        if (otherPath === path || typeof reference !== 'string') continue;
        if (text === reference) return { ok: false, code: 'document_identity_mismatch', matchedPath: otherPath };
        const score = documentSimilarity(text, reference);
        if (score > bestScore) { bestScore = score; matchedPath = otherPath; }
      }
      if (bestScore >= DOCUMENT_PROVENANCE_OTHER_MIN
        && (typeof claimed !== 'string' || documentSimilarity(text, claimed) < DOCUMENT_PROVENANCE_CLAIMED_MAX)) {
        return { ok: false, code: 'document_identity_mismatch', matchedPath };
      }
    } catch (_error) {
      // Unavailable references supply no contradictory evidence.
    }
    return { ok: true };
  }

  // Shared prefix + non-overlapping suffix / longer length. For large files,
  // sample at most 64 Ki UTF-16 units at each edge and cap the denominator at
  // twice that limit. Exact equality above still compares the complete text.
  // No token arrays or quadratic diff: total work is O(total reference text),
  // with bounded per-reference similarity work and constant auxiliary memory.
  function documentSimilarity(left, right) {
    const length = Math.min(left.length, right.length);
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(length, DOCUMENT_PROVENANCE_EDGE_LIMIT) && left[prefix] === right[prefix]) prefix++;
    while (suffix < Math.min(length - prefix, DOCUMENT_PROVENANCE_EDGE_LIMIT)
      && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
    const denominator = Math.min(Math.max(left.length, right.length), 2 * DOCUMENT_PROVENANCE_EDGE_LIMIT);
    return denominator ? (prefix + suffix) / denominator : 1;
  }

  function buildBaseFileLookup(files) {
    if (!Array.isArray(files) || files.length === 0) {
      return null;
    }

    const lookup = new Map();
    for (const file of files) {
      if (typeof file?.path === 'string') {
        const path = normalizePath(file.path);
        if (path) {
          // Patch offsets refer to this exact UTF-16 string. Normalize only
          // for comparisons, never discard the source coordinate system.
          lookup.set(path, String(file.content ?? ''));
        }
      }
    }
    return lookup.size ? lookup : null;
  }

  function checkOperationFreshness(operation, currentContent, baseFileLookup) {
    if (!baseFileLookup || operation?.type !== 'edit') {
      return { ok: true };
    }

    const filePath = normalizePath(operation.path);
    if (!filePath || !baseFileLookup.has(filePath)) {
      return {
        ok: false,
        code: 'missing_base_file',
        reasonKey: 'missingBaseFile',
        reasonParams: { filePath },
        reason: `${filePath || '这个文件'} 在任务开始时没有被 Codex 读到。Codex 没有覆盖它；请刷新项目内容后重试。`
      };
    }

    const baseContent = normalizeText(baseFileLookup.get(filePath));
    const current = normalizeText(currentContent);
    if (current !== baseContent) {
      if (Array.isArray(operation.patches) && operation.patches.length) {
        const preparedPatches = prepareOperationPatches(operation, currentContent, baseFileLookup);
        if (preparedPatches.ok) return { ok: true, reconciled: true, strategy: 'change-envelope', preparedPatches };
      }
      return staleSourceChanged(filePath);
    }

    return { ok: true };
  }

  function staleSourceChanged(filePath) {
    return {
      ok: false,
      code: 'stale_snapshot',
      reasonKey: 'staleSnapshot',
      reasonParams: { filePath },
      reason: `${filePath} 在任务执行期间被你或协作者改过，Codex 没有覆盖它。请查看差异后重试。`
    };
  }

  // Rebase only ranges wholly in a common prefix/suffix. All patches use the
  // same envelope before any of them are applied to the editor.
  function prepareOperationPatches(operation, currentContent, baseFileLookup) {
    const path = normalizePath(operation?.path), base = baseFileLookup?.get(path);
    const current = String(currentContent ?? '');
    const envelope = typeof base === 'string' ? changedEnvelope(normalizeText(base), normalizeText(current)) : null;
    const prepared = mapOperationPatches(operation, current, baseFileLookup, envelope);
    return !prepared.ok && envelope ? staleSourceChanged(path) : prepared;
  }

  function changedEnvelope(base, current) {
    if (base === current) return null;
    let prefix = 0, suffix = 0;
    while (prefix < base.length && prefix < current.length && base[prefix] === current[prefix]) prefix++;
    while (suffix < base.length - prefix && suffix < current.length - prefix
      && base[base.length - suffix - 1] === current[current.length - suffix - 1]) suffix++;
    return { prefix, end: base.length - suffix, delta: current.length - base.length };
  }

  function mapEnvelopeRange(from, to, envelope, insertion = from === to) {
    if (!envelope) return { from, to };
    if (insertion && (from === envelope.prefix || from === envelope.end)) return null;
    if (to <= envelope.prefix) return { from, to };
    if (from >= envelope.end) return { from: from + envelope.delta, to: to + envelope.delta };
    return null;
  }

  // Historical checkpoints already refer to observed applied offsets. This
  // compatibility converter never authorizes a new forward write or rebase.
  function prepareStoredInversePatches(operation, currentContent, baseFileLookup) {
    return mapOperationPatches(operation, currentContent, baseFileLookup, null);
  }

  // Logical LF offsets bridge raw Native and editor coordinates. Expand split
  // CRLF edges before dispatch; keep unchanged editor line endings intact.
  function mapOperationPatches(operation, currentContent, baseFileLookup, envelope) {
    const patches = Array.isArray(operation?.patches) ? operation.patches : [];
    const current = String(currentContent ?? '');
    const path = normalizePath(operation?.path);
    const base = baseFileLookup?.get(path);
    if (!patches.length || typeof base !== 'string' || base === current) {
      return { ok: true, patches };
    }
    const baseMap = lineEndingMap(base);
    const currentMap = lineEndingMap(current);
    if (!baseMap.removed.length && !currentMap.removed.length) {
      if (!envelope) return { ok: true, patches };
      const mapped = [];
      let previousTo = 0;
      for (const patch of patches) {
        const from = Number(patch?.from), to = Number(patch?.to), expected = String(patch?.expected ?? '');
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < previousTo || to < from || to > base.length
          || base.slice(from, to) !== expected) return patchMappingFailure('stale_patch');
        previousTo = to;
        const range = mapEnvelopeRange(from, to, envelope);
        if (!range || current.slice(range.from, range.to) !== expected) return patchMappingFailure('stale_patch');
        mapped.push({ ...range, expected, insert: String(patch.insert ?? '') });
      }
      return { ok: true, patches: mapped };
    }

    const groups = [];
    let previousTo = 0;
    for (const patch of patches) {
      const from = Number(patch?.from), to = Number(patch?.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < previousTo || to < from || to > base.length) {
        return patchMappingFailure('invalid_patch');
      }
      if (base.slice(from, to) !== String(patch.expected ?? '')) return patchMappingFailure('stale_patch');
      previousTo = to;
      // Check each insertion boundary even if CRLF expansion later merges it
      // with an adjacent nonempty range.
      if (!mapEnvelopeRange(baseMap.toLogical(from), baseMap.toLogical(to), envelope, from === to)) {
        return patchMappingFailure('stale_patch');
      }
      // Expand only a split CRLF or a new pair formed across an edit edge.
      // Other neighbouring newlines belong to the editor and stay untouched.
      let start = from, end = to;
      const insert = String(patch.insert ?? '');
      if (base[from - 1] === '\r' && (base[from] === '\n' || insert.startsWith('\n') || (!insert && base[to] === '\n'))) start -= 1;
      if (base[to] === '\n' && (base[to - 1] === '\r' || insert.endsWith('\r') || (!insert && base[from - 1] === '\r'))) end += 1;
      const previous = groups[groups.length - 1];
      if (previous && start <= previous.end) {
        previous.end = Math.max(previous.end, end);
        previous.patches.push({ ...patch, from, to });
      } else groups.push({ start, end, patches: [{ ...patch, from, to }] });
    }

    const mapped = [], sourceChanges = [];
    for (const group of groups) {
      const range = mapEnvelopeRange(baseMap.toLogical(group.start), baseMap.toLogical(group.end), envelope);
      if (!range || range.from < 0 || range.to > currentMap.length) return patchMappingFailure('stale_patch');
      const from = currentMap.toRaw(range.from), to = currentMap.toRaw(range.to);
      const expected = current.slice(from, to);
      if (normalizeText(expected) !== normalizeText(base.slice(group.start, group.end))) {
        return patchMappingFailure('stale_patch');
      }
      let insert = base.slice(group.start, group.end);
      for (const patch of group.patches.slice().sort((left, right) => right.from - left.from)) {
        if (insert.slice(patch.from - group.start, patch.to - group.start) !== String(patch.expected ?? '')) {
          return patchMappingFailure('stale_patch');
        }
        insert = insert.slice(0, patch.from - group.start) + String(patch.insert ?? '') + insert.slice(patch.to - group.start);
      }
      sourceChanges.push({ from: group.start, to: group.end, insert });
      const sourceEnding = nearestLineEnding(base, group.start);
      const editorEnding = nearestLineEnding(current, from);
      if (sourceEnding && editorEnding && sourceEnding !== editorEnding) {
        insert = normalizeText(insert).replace(/\n/g, editorEnding);
      }
      // Leave equal surrounding text out of the dispatch/Track range.
      let prefix = 0, oldEnd = expected.length, newEnd = insert.length;
      while (prefix < oldEnd && prefix < newEnd && expected[prefix] === insert[prefix]) prefix += 1;
      while (oldEnd > prefix && newEnd > prefix && expected[oldEnd - 1] === insert[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
      mapped.push({ from: from + prefix, to: from + oldEnd, expected: expected.slice(prefix, oldEnd), insert: insert.slice(prefix, newEnd) });
    }
    // Preserve source coordinates for line-ending-only conversion. A rebased
    // entry instead advances to its actual verified editor post-image.
    let sourceContent = base;
    for (const patch of sourceChanges.reverse()) {
      sourceContent = sourceContent.slice(0, patch.from) + patch.insert + sourceContent.slice(patch.to);
    }
    return { ok: true, patches: mapped, ...(!envelope ? { sourceContent } : {}) };
  }

  function patchMappingFailure(code) {
    return { ok: false, code, reason: 'Codex 要修改的位置已经无法和当前 Overleaf 内容对齐，所以没有写入。请重新运行任务。' };
  }

  function lineEndingMap(text) {
    const removed = [];
    for (let index = 0; index < text.length - 1; index += 1) {
      if (text[index] === '\r' && text[index + 1] === '\n') removed.push(index);
    }
    function countBefore(offset, logical) {
      let low = 0, high = removed.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (removed[middle] - (logical ? middle : 0) < offset) low = middle + 1;
        else high = middle;
      }
      return low;
    }
    return { removed, length: text.length - removed.length,
      toLogical: offset => offset - countBefore(offset, false),
      toRaw: offset => offset + countBefore(offset, true) };
  }

  function nearestLineEnding(text, offset) {
    let newline = text.indexOf('\n', offset);
    if (newline < 0) newline = text.lastIndexOf('\n', offset - 1);
    return newline < 0 ? '' : text[newline - 1] === '\r' ? '\r\n' : '\n';
  }

  function updateExpectedFileContent(baseFileLookup, filePath, content) {
    const path = normalizePath(filePath);
    if (!baseFileLookup || !path) {
      return;
    }
    baseFileLookup.set(path, String(content ?? ''));
  }

  function removeExpectedFile(baseFileLookup, filePath) {
    const path = normalizePath(filePath);
    if (!baseFileLookup || !path) {
      return;
    }
    baseFileLookup.delete(path);
  }

  function moveExpectedFile(baseFileLookup, fromPath, toPath) {
    const from = normalizePath(fromPath);
    const to = normalizePath(toPath);
    if (!baseFileLookup || !from || !to) {
      return;
    }
    if (!baseFileLookup.has(from)) {
      return;
    }
    const content = baseFileLookup.get(from);
    baseFileLookup.delete(from);
    baseFileLookup.set(to, content);
  }

  function normalizeText(value) {
    return String(value ?? '').replace(/\r\n/g, '\n');
  }

  function normalizePath(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '');
  }

  return {
    assessDocumentProvenance,
    buildBaseFileLookup,
    checkOperationFreshness,
    prepareOperationPatches,
    prepareStoredInversePatches,
    updateExpectedFileContent,
    removeExpectedFile,
    moveExpectedFile,
    normalizePath
  };
});
