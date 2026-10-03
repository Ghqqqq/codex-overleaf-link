(function initStaleGuard(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafStaleGuard = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function staleGuardFactory() {
  'use strict';

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
      if (typeof console !== 'undefined') {
        console.warn('[codex-overleaf] staleGuard: STALE', filePath,
          'base.length:', baseContent.length, 'current.length:', current.length,
          'base[0..80]:', JSON.stringify(baseContent.slice(0, 80)),
          'current[0..80]:', JSON.stringify(current.slice(0, 80)));
      }
      const patchRangeFreshness = checkPatchRangeFreshness(operation, currentContent, baseFileLookup);
      if (patchRangeFreshness) {
        return patchRangeFreshness;
      }
      return {
        ok: false,
        code: 'stale_snapshot',
        reasonKey: 'staleSnapshot',
        reasonParams: { filePath },
        reason: `${filePath} 在任务执行期间被你或协作者改过，Codex 没有覆盖它。请查看差异后重试。`
      };
    }

    return { ok: true };
  }

  function checkPatchRangeFreshness(operation, currentContent, baseFileLookup) {
    const prepared = prepareOperationPatches(operation, currentContent, baseFileLookup);
    if (!prepared.ok) {
      return { ...prepared, code: 'stale_patch_range', reasonKey: 'stalePatchConflict' };
    }
    const patches = prepared.patches;
    if (!patches.length) {
      return null;
    }

    const current = String(currentContent ?? '');
    for (const rawPatch of patches) {
      const from = Number(rawPatch?.from);
      const to = Number(rawPatch?.to);
      const expected = String(rawPatch?.expected ?? '');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > current.length) {
        return {
          ok: false,
          code: 'stale_patch_range',
          reasonKey: 'stalePatchLocation',
          reason: 'Codex 要修改的位置已经无法和当前 Overleaf 内容对齐，所以没有写入。请重新运行任务。'
        };
      }
      if (current.slice(from, to) !== expected) {
        return {
          ok: false,
          code: 'stale_patch_range',
          reasonKey: 'stalePatchConflict',
          reason: 'Codex 要修改的具体位置已经被你或协作者改过，所以没有覆盖它。请查看差异后重试。'
        };
      }
    }

    return {
      ok: true,
      reconciled: true,
      strategy: 'patch-range'
    };
  }

  // Bridge the raw Native baseline to the editor's line-ending representation.
  // Logical LF offsets are only an intermediate coordinate system: both the
  // range check and the eventual editor dispatch use the same raw patches.
  function prepareOperationPatches(operation, currentContent, baseFileLookup) {
    const patches = Array.isArray(operation?.patches) ? operation.patches : [];
    const current = String(currentContent ?? '');
    const path = normalizePath(operation?.path);
    const base = baseFileLookup?.get(path);
    if (!patches.length || typeof base !== 'string' || base === current) {
      return { ok: true, patches };
    }
    const baseMap = lineEndingMap(base);
    const currentMap = lineEndingMap(current);
    // With no CRLF on either side, retain the existing raw range semantics.
    if (!baseMap.removed.length && !currentMap.removed.length) return { ok: true, patches };

    const groups = [];
    let previousTo = 0;
    for (const patch of patches) {
      const from = Number(patch?.from), to = Number(patch?.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < previousTo || to < from || to > base.length) {
        return patchMappingFailure('invalid_patch');
      }
      if (base.slice(from, to) !== String(patch.expected ?? '')) return patchMappingFailure('stale_patch');
      previousTo = to;
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
      const logicalFrom = baseMap.toLogical(group.start), logicalTo = baseMap.toLogical(group.end);
      if (logicalTo > currentMap.length) return patchMappingFailure('invalid_patch');
      const from = currentMap.toRaw(logicalFrom), to = currentMap.toRaw(logicalTo);
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
    // A later operation in the same batch still addresses the original
    // representation, so advance its baseline separately from editor text.
    let sourceContent = base;
    for (const patch of sourceChanges.reverse()) {
      sourceContent = sourceContent.slice(0, patch.from) + patch.insert + sourceContent.slice(patch.to);
    }
    return { ok: true, patches: mapped, sourceContent };
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
    buildBaseFileLookup,
    checkOperationFreshness,
    prepareOperationPatches,
    updateExpectedFileContent,
    removeExpectedFile,
    moveExpectedFile,
    normalizePath
  };
});
