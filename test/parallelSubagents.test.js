const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

const repo = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('parallel-subagents ships as a registered official skill with the full protocol taught', () => {
  const registry = repo('native-host/src/localSkills.js');
  assert.match(registry, /OFFICIAL_CODEX_OVERLEAF_SKILL_IDS = \['annotated-rewrite', 'parallel-subagents'\]/);
  const skill = repo('native-host/src/skills/parallel-subagents/SKILL.md');
  assert.match(skill, /name: parallel-subagents/);
  // handshake, atomic write, disjoint ownership, wave discipline, poll loop,
  // sequential fallback — the load-bearing teachings
  assert.match(skill, /\.codex-overleaf-subagents\/broker\.json/);
  assert.match(skill, /mv \.codex-overleaf-subagents\/jobs\/\.tmp-/);
  assert.match(skill, /no file may appear\r?\nin two jobs/i);
  // v1.6.1: single-file fan-out via scatter-gather slices + the explicit
  // scope iron rule (exact boundaries, no overlap)
  assert.match(skill, /Mode A — serialized scoped jobs/);
  assert.match(skill, /Mode B — scatter-gather slices/);
  assert.match(skill, /run them one at a time|runs them one at a time/);
  assert.match(skill, /\.codex-overleaf-subagents\/work\//);
  assert.match(skill, /verify each slice still starts with its/);
  assert.match(skill, /scopes MUST NOT\r?\noverlap/);
  assert.match(skill, /quote\r?\n  the slice's exact first and last source lines/);
  assert.match(skill, /do \*\*not\*\* edit project files yourself/);
  // broker side: the work/ scratch zone is ownable, the control plane is not
  const broker = repo('native-host/src/subagentBroker.js');
  assert.match(broker, /require\('\.\/subagentWorkspacePath'\)/);
  const { safeWorkspaceRelativePath } = require('../native-host/src/subagentWorkspacePath');
  assert.equal(safeWorkspaceRelativePath('.codex-overleaf-subagents/work/slice.tex'), '.codex-overleaf-subagents/work/slice.tex');
  for (const value of ['.codex-overleaf-subagents/jobs/a.json', '.codex-overleaf-subagents/results/a.json', '.codex-overleaf-subagents/logs/a.log', '.codex-overleaf-subagents/broker.json', '.codex-overleaf-subagents/work/../jobs/a.json', '/tmp/outside.tex']) assert.equal(safeWorkspaceRelativePath(value), null);
  // Note: overlap-serialization (not file_conflict rejection) is locked
  // behaviorally by subagentBroker.test.js ('same-file jobs are serialized' /
  // 'an overlapping job waits while disjoint jobs still run'), so no brittle
  // char-for-char grep of the fillSlots scheduler lives here.
  assert.match(skill, /sleep 10/);
  assert.match(skill, /missing or its\r?\n`status` is not `ready`/);
});

test('runner gates the broker on the enabled skill id and wires lifecycle hooks', () => {
  const runner = repo('native-host/src/codexSessionRunner.js');
  assert.match(runner, /params\.enabledCodexOverleafSkillIds\.includes\(PARALLEL_SUBAGENTS_SKILL_ID\)/);
  // cancel semantics: partial worker edits are discarded via the dirty mark
  assert.match(runner, /onMirrorDirty: \(\) => markMirrorDirty\(\{ projectId, rootDir, reason: 'subagent_run_cancelled' \}\)/);
  // parent finished -> drain before the single mirror diff; errors -> hard stop
  assert.match(runner, /await subagentBroker\.stop\(\{ drain: true \}\);/);
  assert.match(runner, /await subagentBroker\.stop\(\{ drain: false \}\);/);
  // idle watchdog floor while workers are active
  assert.match(runner, /hasExternalActivity: subagentBroker \? \(\) => subagentBroker\.hasActiveWorkers\(\) : undefined/);
  const watchdogBlock = runner.match(/const idleWatchdog = createCodexIdleWatchdog\(idleTimeoutMs,[\s\S]*?\}\);/)?.[0] || '';
  assert.match(watchdogBlock, /input\.hasExternalActivity\?\.\(\)/);
  assert.match(watchdogBlock, /idleWatchdog\.reset\(\);/);
});

test('workers inherit the parent run shape minus the fan-out skill and the timeline', () => {
  const runner = repo('native-host/src/codexSessionRunner.js');
  const workerBlock = runner.match(/runWorkerTask: \(\{ jobId, prompt, signal: workerSignal, onEvent \}\) => runner\(\{[\s\S]*?\}\)\r?\n\s*\}\)/)?.[0] || '';
  assert.match(workerBlock, /task: prompt/);
  assert.match(workerBlock, /threadId: ''/);
  assert.match(workerBlock, /disableCodexOverleafSkillIds: \[PARALLEL_SUBAGENTS_SKILL_ID\]/);
  assert.match(workerBlock, /emit: onEvent/);
  assert.match(workerBlock, /model: params\.model/);
  assert.match(workerBlock, /reasoningEffort: params\.reasoningEffort/);
  const broker = repo('native-host/src/subagentBroker.js');
  assert.match(broker, /onEvent: event => \{[\s\S]*?if \(closed \|\| entry\.status !== 'running'\) return/);
  assert.match(broker, /compactEvent\(event\)/);
  assert.match(broker, /emit\('codex\.subagent\.event'[\s\S]*?source: 'broker', jobId: job\.id/);
  assert.match(workerBlock, /signal: workerSignal/);
  // the strip helper disables by skill-directory name through the per-child
  // skills/config/write rail
  const strip = extractFunction(runner, 'applyWorkerSkillStrip');
  assert.match(strip, /skills\/list/);
  assert.match(strip, /path\.basename\(path\.dirname\(/);
  assert.match(strip, /skills\/config\/write/);
});

test('ownership violations are demoted from syncChanges to unsupportedChanges (S8)', () => {
  const runner = repo('native-host/src/codexSessionRunner.js');
  assert.match(runner, /getViolationPaths\(\)/);
  assert.match(runner, /reason: subagentBroker\.getBlockedReason\(change\.path\)/);
  const block = runner.match(/const subagentViolationPaths[\s\S]*?\r?\n  \}/)?.[0] || '';
  assert.match(block, /rawSyncChanges = rawSyncChanges\.filter\(change => !subagentViolationPaths\.has\(change\.path\)\)/);
  assert.match(block, /unsupportedChanges\.push\(/);
});

test('the subagent queue directory never enters the mirror scan', () => {
  const mirror = repo('native-host/src/mirrorWorkspace.js');
  assert.match(mirror, /const SUBAGENT_QUEUE_DIR = '\.codex-overleaf-subagents';/);
  const walkGuard = mirror.match(/entry\.name === '\.DS_Store'[^\n]*/)?.[0] || '';
  assert.match(walkGuard, /SUBAGENT_QUEUE_DIR/);
  assert.match(mirror, /module\.exports = \{\r?\n  SUBAGENT_QUEUE_DIR,/);
});

test('the broker gate survives reloads and stale queues cannot mislead the model', () => {
  // Fix 1 (v1.6.1): the skills catalog the gate reads persists through the
  // storage compactor — before this, any reload silently disabled the gate
  // until the Skills page was reopened.
  const SessionState = require('../extension/src/shared/sessionState');
  const prepared = SessionState.prepareStateForStorage({
    sessions: [],
    activeSessionId: '',
    codexOverleafSkills: [{ id: 'parallel-subagents', name: 'Parallel Subagents' }]
  });
  assert.deepEqual(prepared.codexOverleafSkills, [{ id: 'parallel-subagents', name: 'Parallel Subagents' }]);
  // Fix 2 (v1.6.1): an unbrokered run removes any stale queue dir so the
  // model never reads a leftover closed handshake.
  const runner = repo('native-host/src/codexSessionRunner.js');
  const elseBlock = runner.match(/\} else if \(!skillInstallTurn\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(elseBlock, /fs\.rmSync\(path\.join\(mirror\.workspacePath, SUBAGENT_QUEUE_DIR\), \{ recursive: true, force: true \}\)/);
  // Fix 3 (v1.6.1): skills.list installs/restores official skills first so a
  // freshly shipped skill is visible in the UI before any codex run.
  const runtime = repo('native-host/src/taskRunnerRuntime.js');
  const listBlock = runtime.match(/function handleSkillsList\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(listBlock, /ensureDefaultCodexOverleafSkills\(\{ env \}\)/);
});

test('panel open primes the skills catalog so the broker gate works without visiting Skills', () => {
  const runtime = repo('extension/src/content/contentRuntime.js');
  const prime = extractFunction(runtime, 'primeCodexOverleafSkillsCatalog');
  assert.match(prime, /state\?\.codexOverleafSkills.*state\.codexOverleafSkills\.length/s);
  assert.match(prime, /scope: 'codex-overleaf'/);
  assert.match(prime, /saveStateSoon\(\)/);
  assert.match(runtime, /primeCodexOverleafSkillsCatalog\(\)\.catch/);
});

test('skipped writeback rows surface the navigation debug payload', () => {
  const formatters = repo('extension/src/content/applyResultFormatters.js');
  const detail = extractFunction(formatters, 'buildSkippedDetail');
  assert.match(detail, /formatApplyResultDebug\(item\?\.result\?\.debug \|\| item\?\.result\?\.diagnostics\)/);
  // and the switch gate accepts a target-base match / refuses known-base drift
  const router = repo('extension/src/page/writebackRouter.js');
  assert.match(router, /\|\| baseMatches\r?\n/);
  assert.match(router, /!baseComparison\.known && contentChangedFromPrevious && settledLongEnough/);
});

test('the subagent timeline flag survives the bridge and both storage compactors (v1.6.4 lock)', () => {
  // The visual subagent track died once already: mapSubagentEvent set the
  // flag but appendNativeEvent's explicit forwarding list dropped it. Lock
  // every hop: producer -> bridge -> appendRunEvent whitelist -> compactors.
  const transcript = require('../extension/src/shared/agentTranscript');
  const mapped = transcript.mapAgentEventToActivity(
    { type: 'codex.subagent.started', title: 'ch1', detail: {} }, { locale: 'en' });
  assert.equal(mapped.subagent, true, 'producer sets the flag');

  const runtime = repo('extension/src/content/contentRuntime.js');
  const bridge = extractFunction(runtime, 'appendNativeEvent');
  assert.match(bridge, /subagent: activity\.subagent === true/, 'bridge forwards the flag');
  const appendEvent = extractFunction(runtime, 'appendRunEvent');
  assert.match(appendEvent, /subagent: input\.subagent === true/, 'whitelist keeps the flag');

  const view = repo('extension/src/content/runTimelineView.js');
  assert.match(view, /row\.dataset\.subagent = 'true'/, 'renderer marks the row');

  const sessionState = require('../extension/src/shared/sessionState');
  const prepared = sessionState.prepareStateForStorage({
    sessions: [{ id: 's1', runs: [{ id: 'r1', task: 't', events: [
      { title: 'sub', status: 'running', kind: 'activity', subagent: true },
      { title: 'plain', status: 'running', kind: 'activity' }
    ] }] }],
    activeSessionId: 's1'
  });
  const events = prepared.sessions[0].runs[0].events;
  assert.equal(events[0].subagent, true, 'sessionState compactor keeps the flag');
  assert.equal('subagent' in events[1], false, 'absent flag stays absent');
});

test('codex.subagent.* events map to bilingual timeline lines', () => {
  const transcript = require('../extension/src/shared/agentTranscript');
  const map = (event, locale) => transcript.mapAgentEventToActivity(event, { locale });
  const started = map({ type: 'codex.subagent.started', title: 'Polish ch3', detail: { activeWorkers: 2, maxWorkers: 3 } }, 'zh');
  assert.match(started.title, /子代理「Polish ch3」开始（2\/3 并行）/);
  assert.equal(started.status, 'running');
  const completed = map({ type: 'codex.subagent.completed', title: 'Polish ch3', detail: { durationMs: 84000 } }, 'en');
  assert.match(completed.title, /Subagent "Polish ch3" completed \(84s\)/);
  const timeoutLine = map({ type: 'codex.subagent.failed', title: 'ch2', detail: { status: 'timeout' } }, 'en');
  assert.match(timeoutLine.title, /timed out/);
  assert.equal(timeoutLine.status, 'warning');
  const violation = map({ type: 'codex.subagent.violation', title: 'main.tex', detail: {} }, 'zh');
  assert.match(violation.title, /未分配给它的文件 main\.tex/);
  assert.match(violation.title, /未写回 Overleaf/);
  assert.match(violation.title, /请重新运行/);
  const rejected = map({ type: 'codex.subagent.rejected', title: 'bad', detail: { reason: 'insufficient_time' } }, 'en');
  assert.match(rejected.title, /rejected \(insufficient_time\)/);
  const drained = map({ type: 'codex.subagent.drained', title: '', detail: {} }, 'zh');
  assert.match(drained.title, /子代理已全部完成/);
  for (const line of [started, completed, timeoutLine, violation, rejected, drained]) {
    assert.equal(line.visible, true);
    assert.ok(line.technicalDetail, 'raw event preserved as collapsed technical detail');
  }
});
