const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const RunPresence = require('../extension/src/content/runPresence');

const tx = en => en;
const fmt = ms => Math.round(ms / 1000) + 's';

// Just enough DOM for the header: innerHTML is recorded and the label/timer
// slots are real child stubs so swaps and ticks can be observed.
function fakeDocument() {
  const make = () => {
    const node = {
      className: '', dataset: {}, children: [], textContent: '', isConnected: true, _html: '',
      set innerHTML(value) {
        this._html = value;
        this.children = [];
        this.label = value.includes('run-presence-label') ? make() : null;
        this.timer = value.includes('run-presence-timer') ? make() : null;
      },
      get innerHTML() { return this._html; },
      get lastElementChild() { return this.children.at(-1) || null; },
      append(child) { this.children.push(child); child.parent = this; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); },
      querySelector(selector) {
        return selector === '.run-presence-label' ? this.label : selector === '.run-presence-timer' ? this.timer : null;
      }
    };
    return node;
  };
  return { createElement: make, make };
}

function harness({ hour = 14, storage = new Map(), random = () => 0.1 } = {}) {
  const document = fakeDocument();
  const presence = RunPresence.create({
    tx, formatElapsed: fmt, document, random,
    now: () => new Date(2026, 8, 30, hour, 10).getTime(),
    storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: fn => fn()
  });
  const labelText = el => el.label.lastElementChild?.innerHTML || '';
  return { presence, document, storage, labelText, el: document.make() };
}

test('the header word changes only at 1, 3, 7 and 15 minutes and ignores tool steps', () => {
  const values = [0.1, 0.5, 0.9, 0.3, 0.7];
  const h = harness({ random: () => values.shift() ?? 0.2 });
  const words = [];
  const paint = elapsedMs => {
    h.presence.paintRunning(h.el, { runId: 'r1', label: { kind: 'idle' }, elapsedMs });
    const word = h.labelText(h.el);
    if (words.at(-1) !== word) words.push(word);
  };
  for (let second = 0; second <= 480; second += 1) paint(second * 1000);
  assert.equal(words.length, 4, 'a 8-minute run shows only four words');
  assert.ok(RunPresence.VERBS.en.some(verb => words[0].includes(verb + '…')));
  assert.match(words[0], /run-shimmer/);
  assert.equal(h.el.timer.textContent, '480s');
  assert.equal(h.el.label.children.length, 1, 'faded words are removed');
});

test('named stages replace the word; idle resumes without a new word inside the same slot', () => {
  const h = harness();
  h.presence.paintRunning(h.el, { runId: 'r1', label: { kind: 'idle' }, elapsedMs: 5000 });
  const word = h.labelText(h.el);
  h.presence.paintRunning(h.el, { runId: 'r1', label: { kind: 'stage', text: 'Syncing changes to Overleaf' }, elapsedMs: 6000 });
  assert.match(h.labelText(h.el), /Syncing changes to Overleaf…/);
  h.presence.paintRunning(h.el, { runId: 'r1', label: { kind: 'idle' }, elapsedMs: 7000 });
  assert.notEqual(h.labelText(h.el), '');
  assert.ok(RunPresence.VERBS.en.some(verb => h.labelText(h.el).includes(verb)), word);
});

test('late-night and long-proof eggs are shown once and in the review tone', () => {
  const storage = new Map();
  const h = harness({ hour: 23, storage });
  h.presence.paintRunning(h.el, { runId: 'r1', label: { kind: 'idle' }, elapsedMs: 0 });
  assert.match(h.labelText(h.el), /is-egg">Burning the midnight oil…/);
  const again = harness({ hour: 23, storage });
  again.presence.paintRunning(again.el, { runId: 'r2', label: { kind: 'idle' }, elapsedMs: 0 });
  assert.doesNotMatch(again.labelText(again.el), /midnight/, 'once per night');

  h.presence.tick(h.el, 121000);
  assert.match(h.labelText(h.el), /This is a long proof…/, 'replaces the word once the run passes two minutes');
  h.presence.tick(h.el, 150000);
  assert.match(h.labelText(h.el), /long proof/, 'stays until the next slot');
  h.presence.tick(h.el, 180000);
  assert.doesNotMatch(h.labelText(h.el), /long proof/, 'once per run');
});

test('done settles into ∎ plus the facts of the run; stopped leaves the proof open', () => {
  const done = RunPresence.settledHtml({ kind: 'done', elapsedMs: 42000, files: 3, added: 120, removed: 40,
    compiled: true, animate: true }, tx, fmt);
  assert.match(done, /codex-sr-only">Done</);
  assert.match(done, /run-qed is-settling/);
  assert.match(done, /42s[\s\S]*3 files[\s\S]*\+120[\s\S]*−40[\s\S]*compiled/);
  assert.doesNotMatch(done, /✓/);

  const steps = RunPresence.settledHtml({ kind: 'done', elapsedMs: 5000, files: 0, steps: 4 }, tx, fmt);
  assert.match(steps, /4 steps/);
  assert.doesNotMatch(steps, /is-settling/, 'history cards do not replay the settle animation');

  const stopped = RunPresence.settledHtml({ kind: 'stopped', elapsedMs: 18000 }, tx, fmt);
  assert.match(stopped, /run-qed is-open/);
  assert.match(stopped, /\\end\{draft\}[\s\S]*stopped at 18s/);
});

test('first clean compile is celebrated once per project', () => {
  const h = harness();
  const facts = { kind: 'done', elapsedMs: 9000, files: 1, compiled: true, projectId: 'p1', animate: true };
  h.presence.paintSettled(h.el, facts);
  assert.match(h.el.innerHTML, /is-first/);
  assert.match(h.el.innerHTML, /Q\.E\.D\. — first clean compile/);
  const next = h.document.make();
  h.presence.paintSettled(next, facts);
  assert.doesNotMatch(next.innerHTML, /Q\.E\.D\./);
});

test('failures stay plain and escape their text', () => {
  const h = harness();
  h.presence.paintSettled(h.el, { kind: 'failed', text: 'Failed <b>1s</b>' });
  assert.equal(h.el.dataset.presence, 'failed');
  assert.match(h.el.innerHTML, /Failed &lt;b&gt;1s&lt;\/b&gt;/);
  assert.doesNotMatch(h.el.innerHTML, /run-qed|run-shimmer/);
});

test('presence is wired into the timeline and styled with shared motion tokens', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const css = read('extension/styles/panel.css');
  assert.match(read('extension/entries/content-entry.mjs'), /runPresence\.js';\nimport '..\/src\/content\/runActivitySummary\.js/);
  assert.match(read('extension/src/content/runTimelineView.js'), /RunPresence\?\.create\(/);
  assert.match(read('extension/src/content/runActivitySummary.js'), /presence\.paintRunning\(status/);
  assert.match(css, /--tl-m-spin: 800ms/);
  assert.match(css, /\.run-mark-leaf \{ background-image: url\("data:image\/png;base64,/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\n  #codex-overleaf-panel \.run-status\[data-presence\] \*/);
  for (const file of ['settingsPanel', 'modelPicker', 'diffReviewPanel', 'markdownDomRenderer']) {
    assert.doesNotMatch(read('extension/src/content/' + file + '.js'), /[✓✗]/, file + ' uses SVG glyphs');
  }
});

test('default timers are called unbound, as browsers require', () => {
  const saved = globalThis.setTimeout;
  let calls = 0;
  // Browsers throw "Illegal invocation" when a timer runs with a non-window `this`.
  globalThis.setTimeout = function strictTimer(fn) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls += 1;
    return fn();
  };
  try {
    const document = fakeDocument();
    const presence = RunPresence.create({ tx, formatElapsed: fmt, document, storage: null });
    const el = document.make();
    presence.paintRunning(el, { runId: 'r1', label: { kind: 'idle' }, elapsedMs: 0 });
    presence.paintRunning(el, { runId: 'r1', label: { kind: 'stage', text: 'Preparing' }, elapsedMs: 1000 });
    assert.equal(calls, 1);
    assert.equal(el.label.children.length, 1, 'the label is never left blank after a swap');
    assert.match(el.label.lastElementChild.innerHTML, /Preparing…/);
  } finally {
    globalThis.setTimeout = saved;
  }
});

test('shell-wrapped commands are shortened for the live header', () => {
  assert.equal(RunPresence.commandSummary(`/bin/zsh -lc "cd [local path] && grep -n '^#' roadmap.md | head"`), `grep -n '^#' roadmap.md`);
  assert.equal(RunPresence.commandSummary("/bin/zsh -lc 'cd [local path] && for k in ong2025routellm; do echo $k; done'"), 'for k in ong2025routellm');
  assert.equal(RunPresence.commandSummary('latexmk -pdf main.tex'), 'latexmk -pdf main.tex');
  assert.ok(RunPresence.commandSummary('x'.repeat(80)).length <= 48);
});

test('reasoning streams become thought rounds in event order instead of hidden diagnostics', () => {
  const Model = require('../extension/src/shared/runActivityModel');
  const events = [
    { kind: 'activity', title: 'Codex is analyzing.', timestamp: '2026-09-30T14:47:13.000Z', activity: { v: 1, kind: 'lifecycle', state: 'running', target: 'working' } },
    { kind: 'stream', streamRole: 'reasoning', streamKey: 'r1', status: 'completed', title: 'Check the decision rule first. Then the box.', timestamp: '2026-09-30T14:47:31.000Z' },
    { kind: 'activity', title: 'Read', timestamp: '2026-09-30T14:47:32.000Z', activity: { v: 1, kind: 'explore', id: 'e1', state: 'completed', action: 'read', paths: ['main.tex'] } },
    { kind: 'stream', streamRole: 'reasoning', streamKey: 'r2', status: 'completed', title: '   ', timestamp: '2026-09-30T14:47:40.000Z' },
    { kind: 'stream', streamRole: 'assistant', streamKey: 'a1', status: 'completed', title: 'Now applying the edits.', timestamp: '2026-09-30T14:47:41.000Z' }
  ];
  const projection = Model.project({ status: 'completed', events });
  assert.deepEqual(projection.blocks.map(block => block.kind), ['thought', 'exploreGroup', 'message']);
  assert.equal(projection.blocks[0].startedAt, '2026-09-30T14:47:13.000Z', 'duration starts at the preceding event');
  assert.ok(!projection.diagnostics.some(entry => entry.event.streamKey === 'r1'));
});

test('thought rows stream three lines live, then fold to a timed one-liner that opens to the full text', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const summary = read('extension/src/content/runActivitySummary.js');
  const css = read('extension/styles/panel.css');
  assert.match(summary, /if \(block\.kind === 'thought'\) return makeThought/);
  assert.match(summary, /tx\('Thought ' \+ seconds, '思考 ' \+ seconds\)/);
  assert.match(css, /\.run-workflow-thought-tail \{[^}]*max-height: calc\(3 \* 1\.55em\)/);
  assert.match(css, /\.run-workflow-thought\[data-live="true"\] > \.run-workflow-thought-line \{ display: none; \}/);
});

test('the ∎ header owns the file count, including the recorded-only caveat for clipped histories', () => {
  const clipped = RunPresence.settledHtml({ kind: 'done', elapsedMs: 65000, files: 1, filesClipped: true, compiled: true }, tx, fmt);
  assert.match(clipped, /1 file recorded/);
  const summary = fs.readFileSync(path.join(__dirname, '../extension/src/content/runActivitySummary.js'), 'utf8');
  assert.match(summary, /card\.metrics\.hidden = active \|\| !result\.fileCount \|\| Boolean\(presence\);/);
});

test('a locale refresh re-renders the empty state instead of overwriting the mark', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
  const start = runtime.indexOf('function applyLocaleToPanel()');
  const body = runtime.slice(start, runtime.indexOf('\n  }\n', start));
  // '.empty-runs div' matched the first div, which is the animated mark.
  assert.doesNotMatch(body, /\.empty-runs div/);
  assert.match(body, /querySelector\('\.empty-runs'\)\) renderRunHistory\(\)/);
});
