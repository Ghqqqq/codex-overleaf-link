(function initCodexOverleafWrittenChangesView(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafModuleRegistry.define('WrittenChangesView', [], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function writtenChangesViewFactory() {
  'use strict';

  // Read-only receipt for changes already written to Overleaf: one folded row
  // per file, and inside it only the changed lines with word-level marks.
  // Reviewing-mode hunks with Accept/Reject stay in DiffReviewPanel.
  const CONTEXT_LINES = 1;
  const MAX_WORD_DIFF_TOKENS = 600;
  // CJK characters diff one by one; Latin words, spaces and punctuation as runs.
  const TOKEN = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]|[A-Za-z0-9_]+|\s+|\\[A-Za-z]+|[^\sA-Za-z0-9_\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

  function tokenize(text) {
    return String(text || '').match(TOKEN) || [];
  }

  // Classic LCS over tokens; returns [{ type: 'same'|'del'|'ins', text }].
  function diffWords(before, after) {
    const a = tokenize(before), b = tokenize(after);
    if (a.length > MAX_WORD_DIFF_TOKENS || b.length > MAX_WORD_DIFF_TOKENS) {
      return [{ type: 'del', text: String(before) }, { type: 'ins', text: String(after) }];
    }
    const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const parts = [];
    const push = (type, text) => {
      const last = parts[parts.length - 1];
      if (last?.type === type) last.text += text; else parts.push({ type, text });
    };
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { push('same', a[i]); i += 1; j += 1; }
      else if (table[i + 1][j] >= table[i][j + 1]) { push('del', a[i]); i += 1; }
      else { push('ins', b[j]); j += 1; }
    }
    while (i < a.length) push('del', a[i++]);
    while (j < b.length) push('ins', b[j++]);
    return parts;
  }

  // Turns diff hunk lines into display rows: paired remove/add runs become one
  // merged row; long unchanged stretches fold into a gap row.
  function buildRows(lines) {
    const rows = [];
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (line?.type !== 'remove' && line?.type !== 'add') {
        rows.push({ kind: 'context', text: String(line?.text ?? '') });
        index += 1;
        continue;
      }
      const removed = [], added = [];
      while (lines[index]?.type === 'remove') removed.push(String(lines[index++].text ?? ''));
      while (lines[index]?.type === 'add') added.push(String(lines[index++].text ?? ''));
      const paired = Math.min(removed.length, added.length);
      for (let k = 0; k < paired; k += 1) rows.push({ kind: 'change', parts: diffWords(removed[k], added[k]) });
      for (const text of removed.slice(paired)) rows.push({ kind: 'change', parts: [{ type: 'del', text }] });
      for (const text of added.slice(paired)) rows.push({ kind: 'change', parts: [{ type: 'ins', text }] });
    }
    const near = rows.map((row, index) => row.kind === 'change'
      || rows.slice(Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1).some(other => other.kind === 'change'));
    const out = [];
    for (let index = 0; index < rows.length;) {
      if (near[index]) { out.push(rows[index]); index += 1; continue; }
      let end = index;
      while (end < rows.length && !near[end]) end += 1;
      out.push({ kind: 'gap', count: end - index });
      index = end;
    }
    return out;
  }

  function countLines(diff) {
    let added = 0, removed = 0;
    for (const hunk of diff || []) {
      for (const line of hunk?.lines || []) {
        if (line?.type === 'add') added += 1;
        else if (line?.type === 'remove') removed += 1;
      }
    }
    return { added, removed };
  }

  function render(changes, { document: doc = globalThis.document, tx = en => en } = {}) {
    const make = (tag, className, text) => {
      const el = doc.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const list = make('div', 'run-written-changes');
    list.setAttribute('role', 'list');
    for (const change of changes || []) {
      if (!change?.path || !Array.isArray(change.diff) || !change.diff.length) continue;
      const file = make('details', 'run-written-file');
      file.setAttribute('role', 'listitem');
      const summary = make('summary', 'run-written-file-sum');
      const name = make('span', 'run-written-file-name', change.path.split('/').pop());
      name.title = change.path;
      const { added, removed } = countLines(change.diff);
      summary.append(name);
      if (change.path.includes('/')) summary.append(make('span', 'run-written-file-dir', change.path.slice(0, change.path.lastIndexOf('/'))));
      const counts = make('span', 'run-written-file-counts');
      counts.append(make('span', 'run-written-add', '+' + added), make('span', 'run-written-del', '−' + removed));
      counts.setAttribute('aria-label', tx(`${added} lines added, ${removed} removed`, `新增 ${added} 行，删除 ${removed} 行`));
      summary.append(counts);
      file.append(summary);
      // Lazy body: thesis chapters produce long diffs, so build on first open.
      file.addEventListener('toggle', () => {
        if (!file.open || file.dataset.built) return;
        file.dataset.built = 'true';
        const body = make('div', 'run-written-body');
        for (const hunk of change.diff) {
          if (hunk?.truncated) {
            body.append(make('div', 'run-written-row run-written-note', String(hunk.lines?.[0]?.text || '')));
            continue;
          }
          const head = make('div', 'run-written-hunk', tx(`Line ${hunk?.startB ?? '?'}`, `第 ${hunk?.startB ?? '?'} 行`));
          body.append(head);
          for (const row of buildRows(hunk?.lines || [])) {
            if (row.kind === 'gap') {
              body.append(make('div', 'run-written-row run-written-gap', tx(`… ${row.count} unchanged lines`, `… ${row.count} 行未改动`)));
            } else if (row.kind === 'context') {
              body.append(make('div', 'run-written-row', row.text || ' '));
            } else {
              const line = make('div', 'run-written-row is-changed');
              for (const part of row.parts) {
                line.append(part.type === 'same' ? doc.createTextNode(part.text)
                  : make(part.type === 'ins' ? 'ins' : 'del', '', part.text));
              }
              body.append(line);
            }
          }
        }
        file.append(body);
      });
      list.append(file);
    }
    return list;
  }

  return { render, diffWords, buildRows, countLines };
});
