'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SelectionContext = require('../../extension/src/shared/selectionContext');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'selected_context_unresolved' });
}

function prepareSelectionScope(value, workspacePath, projectId) {
  if (value == null) return null;
  const selection = SelectionContext.normalize(value);
  if (!selection || selection.projectId !== String(projectId)) {
    throw invalid('The attached selection is invalid or belongs to another project. Select it again.');
  }
  if (selection.mode !== 'edit') return { selection };
  let before;
  try {
    const root = fs.realpathSync(workspacePath);
    const target = fs.realpathSync(path.resolve(root, selection.path));
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw invalid('The selected file is outside the project workspace.');
    }
    before = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'selected_context_unresolved') throw error;
    throw invalid('The selected file could not be read. Select it again after the project is synchronized.');
  }
  const digest = hash(before);
  if (digest === selection.documentHash && before.slice(selection.from, selection.to) === selection.text) {
    return { selection, before };
  }
  const proof = selection.rebaseEvidence;
  const candidates = new Map();
  const add = (from, to) => {
    if (Number.isSafeInteger(from) && from >= 0 && to <= before.length
      && before.slice(from, to) === selection.text) candidates.set(from + ':' + to, { from, to });
  };
  if (proof) {
    // Full flanks define positions; never search for a possibly repeated passage.
    if (selection.from <= before.length && hash(before.slice(0, selection.from)) === proof.prefixHash) {
      add(selection.from, selection.from + selection.text.length);
    }
    const suffixLength = proof.documentLength - selection.to;
    const to = before.length - suffixLength;
    if (to >= 0 && hash(before.slice(to)) === proof.suffixHash) add(to - selection.text.length, to);
  }
  if (candidates.size !== 1) {
    throw invalid('The selected passage could not be safely mapped to the changed document. Select it again before editing.');
  }
  const { from, to } = [...candidates.values()][0];
  const rebased = SelectionContext.normalize({ ...selection, from, to, documentHash: digest,
    lineStart: before.slice(0, from).split('\n').length,
    lineEnd: before.slice(0, Math.max(from, to - 1)).split('\n').length,
    rebaseEvidence: { v: 1, documentLength: before.length,
      prefixHash: hash(before.slice(0, from)), suffixHash: hash(before.slice(to)) } });
  return { selection: rebased, before, rebased: true,
    original: { from: selection.from, to: selection.to, documentHash: selection.documentHash } };
}

function hash(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

function filterSelectionChanges(changes, scope) {
  const items = Array.isArray(changes) ? changes : [];
  if (scope?.selection?.mode !== 'edit') return { changes: items, unsupportedChanges: [] };
  const { selection, before } = scope;
  const prefix = before.slice(0, selection.from);
  const suffix = before.slice(selection.to);
  const withinSelection = change => change?.type === 'write' && change.path === selection.path
    && change.previousContent === before && typeof change.content === 'string'
    && change.content.length >= prefix.length + suffix.length
    && change.content.startsWith(prefix) && change.content.endsWith(suffix);
  const selectedPathCount = items.filter(change => change?.path === selection.path).length;
  const allowed = change => selectedPathCount === 1 && withinSelection(change);
  return {
    changes: items.filter(allowed),
    unsupportedChanges: items.filter(change => !allowed(change)).map(change => ({
      type: 'unsupported-local-file', path: change?.path || '', reason: 'selection_scope_violation'
    }))
  };
}

module.exports = { prepareSelectionScope, filterSelectionChanges };
