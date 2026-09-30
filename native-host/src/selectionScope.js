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
  const digest = crypto.createHash('sha256').update(before, 'utf8').digest('hex');
  if (digest !== selection.documentHash || before.slice(selection.from, selection.to) !== selection.text) {
    throw invalid('The document changed after the selection was captured. Select the passage again before editing.');
  }
  return { selection, before };
}

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
  if (items.every(withinSelection)) return { changes: items, unsupportedChanges: [] };
  return {
    changes: [],
    unsupportedChanges: items.map(change => ({
      type: 'unsupported-local-file', path: change.path, reason: 'selection_scope_violation'
    }))
  };
}

module.exports = { prepareSelectionScope, filterSelectionChanges };
