const assert = require('node:assert/strict');
const test = require('node:test');

const projectFiles = require('../extension/src/shared/projectFiles');
const governance = require('../extension/src/shared/governanceRules');

test('safe project path validator rejects unsafe governance operation paths', () => {
  for (const filePath of [
    '../x',
    '.',
    '..',
    '/abs.tex',
    'C:\\tmp\\x.tex',
    'folder\\file.tex',
    'folder/../file.tex',
    'bad\u0000name.tex'
  ]) {
    assert.equal(projectFiles.normalizeSafeProjectPath(filePath), '', filePath);
  }
});

test('normalizeGovernanceRules keeps only valid rule fields', () => {
  const rules = governance.normalizeGovernanceRules({
    readonlyPatterns: [' locked/** ', '', 42],
    writablePatterns: ['src/*.tex', null, ' assets/** '],
    sensitiveCheckEnabled: false,
    sensitiveConfirmAllowed: true
  });

  assert.deepEqual(rules, {
    readonlyPatterns: ['locked/**'],
    writablePatterns: ['src/*.tex', 'assets/**'],
    sensitiveCheckEnabled: false,
    sensitiveConfirmAllowed: true
  });
});

test('matchesGovernancePattern supports star, globstar, and normalized paths', () => {
  assert.equal(governance.matchesGovernancePattern('chapters/intro.tex', 'chapters/*.tex'), true);
  assert.equal(governance.matchesGovernancePattern('/figures/nested/plot.pdf', 'figures/**'), true);
  assert.equal(governance.matchesGovernancePattern('figures/plot.pdf', '*.pdf'), false);
});

test('evaluateGovernedOperations blocks readonly writes and allowlist misses', () => {
  const result = governance.evaluateGovernedOperations([
    { type: 'edit', path: 'main.tex' },
    { type: 'delete', path: 'locked/appendix.tex' },
    { type: 'create', path: 'notes/private.tex' },
    { type: 'rename', path: 'chapters/old.tex', destinationPath: 'locked/new.tex' },
    { type: 'move', path: 'main.tex', to: 'locked/main.tex' },
    { type: 'binary-create', path: 'figures/chart.pdf' }
  ], {
    readonlyPatterns: ['locked/**'],
    writablePatterns: ['main.tex', 'figures/**']
  });

  assert.deepEqual(result.allowed.map(operation => operation.path), ['main.tex', 'figures/chart.pdf']);
  assert.deepEqual(result.blocked.map(entry => ({
    type: entry.operation.type,
    path: entry.operation.path,
    destinationPath: entry.operation.destinationPath || '',
    reason: entry.reason
  })), [
    { type: 'delete', path: 'locked/appendix.tex', destinationPath: '', reason: 'readonly' },
    { type: 'create', path: 'notes/private.tex', destinationPath: '', reason: 'writable_allowlist' },
    { type: 'rename', path: 'chapters/old.tex', destinationPath: 'locked/new.tex', reason: 'readonly' },
    { type: 'move', path: 'main.tex', destinationPath: 'locked/main.tex', reason: 'readonly' }
  ]);
});

test('evaluateGovernedOperations blocks unsafe write paths', () => {
  const result = governance.evaluateGovernedOperations([
    { type: 'edit', path: '../x' },
    { type: 'create', path: '.' },
    { type: 'delete', path: '/abs.tex' },
    { type: 'rename', path: 'main.tex', destinationPath: 'folder/../file.tex' },
    { type: 'move', path: 'main.tex', to: 'C:\\tmp\\x.tex' },
    { type: 'binary-create', path: 'figures\\plot.pdf' }
  ], {
    writablePatterns: ['**']
  });

  assert.deepEqual(result.allowed, []);
  assert.deepEqual(result.blocked.map(entry => ({
    type: entry.operation.type,
    reason: entry.reason
  })), [
    { type: 'edit', reason: 'invalid_project_path' },
    { type: 'create', reason: 'invalid_project_path' },
    { type: 'delete', reason: 'invalid_project_path' },
    { type: 'rename', reason: 'invalid_project_path' },
    { type: 'move', reason: 'invalid_project_path' },
    { type: 'binary-create', reason: 'invalid_project_path' }
  ]);
});


test('URL input rejects encoded traversal while canonical operation names remain exact literals', () => {
  for (const name of ['folder/%2e%2e/file.tex','folder/%252e%252e/file.tex','folder%2Ffile.tex']) {
    assert.equal(projectFiles.normalizeUrlEncodedProjectPath(name), '');
    const result = governance.evaluateGovernedOperations([{type:'create',path:name}], {writablePatterns:['**']});
    assert.equal(result.allowed[0].path,name);
  }
  const result=governance.evaluateGovernedOperations([
    {type:'edit',path:'a%20b.tex'},{type:'edit',path:'a b.tex'}
  ], {readonlyPatterns:['a b.tex']});
  assert.deepEqual(result.allowed.map(item=>item.path),['a%20b.tex']);
  assert.deepEqual(result.blocked.map(item=>item.operation.path),['a b.tex']);
});
