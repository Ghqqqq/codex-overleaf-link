const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCodexTurnPrompt,
  validatePromptSize
} = require('../native-host/src/codexPromptAssembly');

test('buildCodexTurnPrompt separates system context from the user request', () => {
  const prompt = buildCodexTurnPrompt({
    task: 'Polish the introduction.',
    customInstructions: 'Prefer concise academic prose.',
    skills: [{ id: 'style', name: 'Style Guide', content: 'Avoid vague claims.' }],
    skillInvocation: { skillId: 'style', forced: true },
    attachments: [{ name: 'notes.txt', relativePath: '.codex-overleaf-attachments/notes.txt', size: 12, mimeType: 'text/plain' }],
    activePath: 'main.tex',
    contextFiles: ['sections/intro.tex'],
    compileContext: { enabled: true, logSummary: 'LaTeX Warning: Citation undefined.' },
    mode: 'auto',
    session: {
      id: 'session-1',
      history: [{ task: 'Earlier task', result: 'Done' }]
    },
    projectKey: 'project-1',
    workspacePath: '/tmp/project-1'
  });

  assert.match(prompt.systemPrompt, /Session id: session-1/);
  assert.match(prompt.systemPrompt, /Prefer concise academic prose/);
  assert.match(prompt.systemPrompt, /## style: Style Guide/);
  assert.match(prompt.systemPrompt, /Avoid vague claims/);
  assert.match(prompt.systemPrompt, /\.codex-overleaf-attachments\/notes\.txt/);
  assert.match(prompt.systemPrompt, /main\.tex/);
  assert.match(prompt.systemPrompt, /sections\/intro\.tex/);
  assert.match(prompt.systemPrompt, /Citation undefined/);
  assert.equal(prompt.userPrompt, 'Current user request:\nPolish the introduction.');
});

test('buildCodexTurnPrompt instructs Codex to cite Overleaf project-relative locations', () => {
  const workspacePath = '/Users/alice/.codex-overleaf/projects/p/workspace';
  const prompt = buildCodexTurnPrompt({
    task: 'Review labels.',
    activePath: 'main.tex',
    contextFiles: ['main.tex', 'sections/intro.tex'],
    mode: 'ask',
    projectKey: 'project-1',
    workspacePath
  });

  assert.match(prompt.systemPrompt, /Overleaf project-relative paths/);
  assert.match(prompt.systemPrompt, /path:LINE\[:COLUMN\]/);
  assert.match(prompt.systemPrompt, /Do not cite local absolute paths/);
  assert.match(prompt.systemPrompt, /Do not wrap project location citations in backticks/);
  assert.match(prompt.systemPrompt, /file:\/\//);
  assert.match(prompt.systemPrompt, /main\.tex/);
  assert.match(prompt.systemPrompt, /sections\/intro\.tex/);
  assert.doesNotMatch(prompt.systemPrompt, /\/Users\//);
  assert.doesNotMatch(prompt.systemPrompt, /C:\\Users\\/);
  assert.doesNotMatch(prompt.systemPrompt, /\.codex-overleaf\/projects/);
  assert.doesNotMatch(prompt.systemPrompt, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const inventory = prompt.systemPrompt.match(/Focused project file inventory:\n([\s\S]*?)\n\n/)?.[1] || '';
  assert.match(inventory, /- main\.tex/);
  assert.match(inventory, /- sections\/intro\.tex/);
  assert.doesNotMatch(inventory, /\/tmp\/project-1/);
  assert.equal((inventory.match(/main\.tex/g) || []).length, 1);
});

test('validatePromptSize reports total prompt characters and native-message overflow', () => {
  const small = validatePromptSize('system', 'user');
  assert.deepEqual(small, {
    ok: true,
    totalChars: 10,
    exceedsLimit: false
  });

  const large = validatePromptSize('x'.repeat(1024 * 1024), 'y');
  assert.equal(large.ok, false);
  assert.equal(large.exceedsLimit, true);
  assert.equal(large.totalChars, 1024 * 1024 + 1);
});

test('buildCodexTurnPrompt redacts secrets and local paths from the compile log before it reaches Codex', () => {
  // Review BLOCKER B5: LaTeX compile logs routinely embed local absolute
  // paths (and occasionally secrets from custom .latexmkrc) and were sent
  // verbatim to the Codex model (a third party). The prompt assembly must
  // redact them. Exercised through the public buildCodexTurnPrompt so we
  // don't widen the module's export surface.
  const poisonedLog = [
    'This is pdfTeX, Version 3.14',
    '(/Users/alice/Library/texmf/tex/latex/custom.sty',
    'Loading from /private/var/folders/xy/tmpAbc/main.aux',
    'curl -H "Authorization: Bearer ' + 'a'.repeat(40) + '" https://api.example.com',
    'AWS key AKIA' + 'ABCDEFGHIJKLMNOP',
    '! LaTeX Error: File `missing.sty\' not found at /Library/TeX/texmf-dist/foo'
  ].join('\n');

  const prompt = buildCodexTurnPrompt({
    task: 'fix the build',
    mode: 'auto',
    compileLog: poisonedLog,
    compileErrors: ['/Users/alice/project/main.tex:42 undefined control sequence'],
    compileWarnings: ['Overfull hbox in /Users/alice/project/intro.tex']
  });

  const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);

  // Local absolute paths must be gone from the compile context.
  assert.equal(text.includes('/Users/alice'), false, 'leaked a /Users path');
  assert.equal(text.includes('/private/var/folders'), false, 'leaked a /private/var path');
  // Secrets must be redacted.
  assert.equal(text.includes('Bearer ' + 'a'.repeat(40)), false, 'leaked a Bearer token');
  assert.equal(text.includes('AKIA' + 'ABCDEFGHIJKLMNOP'), false, 'leaked an AWS key');
  // Redaction placeholders should be present (proves the path went through redactCompileLogText).
  assert.match(text, /<local-path>|<TEXLIVE_PATH>|\[REDACTED/);
  // Non-sensitive log content is preserved (we redact, not drop).
  assert.match(text, /pdfTeX/);
  assert.match(text, /undefined control sequence/);
});

test('buildCodexTurnPrompt redacts the full canonical Unix top-level set from the compile log', () => {
  // v1.4.1: redactCompileLogText widened to the canonical pathRedaction.js
  // UNIX_TOPLEVELS, so Linux / external-volume compile logs (/home /opt /etc
  // /usr /Volumes /srv /mnt /media) no longer leak absolute paths to Codex —
  // while /usr/local/texlive keeps its dedicated <TEXLIVE_PATH> placeholder
  // (the TeX rules still run first).
  const log = [
    'reading /home/bob/project/main.tex',
    'config at /etc/texmf/web2c/texmf.cnf',
    'cache /opt/cache/foo.fmt',
    'bin /usr/bin/pdflatex',
    'volume /Volumes/Backup/refs.bib',
    'texlive /usr/local/texlive/2026/tex/latex/base/article.cls'
  ].join('\n');

  const prompt = buildCodexTurnPrompt({
    task: 'fix the build',
    mode: 'auto',
    compileLog: log,
    compileErrors: ['/opt/build/main.tex:9 some error'],
    compileWarnings: ['warning in /home/bob/intro.tex']
  });
  const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);

  for (const leak of ['/home/bob', '/etc/texmf', '/opt/cache', '/opt/build', '/usr/bin', '/Volumes/Backup']) {
    assert.equal(text.includes(leak), false, `leaked ${leak}`);
  }
  // The texlive tree keeps its dedicated placeholder (rule ordering preserved).
  assert.equal(text.includes('/usr/local/texlive'), false, 'leaked a texlive path');
  assert.match(text, /<TEXLIVE_PATH>/);
});
