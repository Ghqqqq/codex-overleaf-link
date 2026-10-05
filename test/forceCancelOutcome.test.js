'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { background, memoryStorage, flush } = require('./_helpers/backgroundJournalHarness');
const { extractFunction } = require('./_helpers/extractFunction');
const Actions = require('../extension/src/content/runRecoveryActions');
const Registry = require('../extension/src/content/legacyGlobalRegistry');
function productionModules() {
  const root = Object.fromEntries([...Registry.requiredModules, ...Registry.supportModules].map(name => ['CodexOverleaf' + name, {}]));
  root.CodexOverleafRunRecoveryActions = Actions;
  return Registry.create(root).modules;
}
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
test('ordinary and force cancel acknowledge sending without claiming a Native release result', async t => {
  const bg = background(memoryStorage()); t.after(() => bg.timer.clear());
  const answer = await bg.send({ type: 'codex-overleaf/native-request', payload: { id: 'force-one', method: 'codex.cancel', params: { projectKey: 'project-one', force: true } } });
  assert.equal(bg.ports[0].messages[0].id, 'force-one');
  assert.equal(answer.result.sent, true); assert.equal(answer.result.lockReleased, undefined);
  // The unassociated later Native response cannot strengthen the sent receipt.
  bg.ports[0].emit({ id: 'force-one', ok: true, result: { cancelled: false, lockReleased: true } });
  assert.equal(answer.result.lockReleased, undefined);
  const simple = await bg.send({ type: 'codex-overleaf/native-request', payload: { id: 'cancel-one', method: 'codex.cancel', params: { requestId: 'run-one' } } });
  assert.equal(simple.result.sent, true);
});

class Element {
  constructor() { this.dataset = {}; this.children = []; this.listeners = {}; this.disabled = false; this.textContent = ''; }
  append(node) { this.children.push(node); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
for (const [name, response, expected] of [
  ['sent only', { ok: true, result: { sent: true } }, /not yet confirmed|尚未确认/],
  ['unknown receipt', { ok: true, result: {} }, /not yet confirmed|尚未确认/],
  ['cancel accepted', { ok: true, result: { cancelled: true } }, /Wait|等待/],
  ['lock released', { ok: true, result: { lockReleased: true } }, /released|已释放/],
  ['no task', { ok: true, result: { cancelled: false } }, /No active|未发现|没有发现/],
  ['failed', { ok: false, error: { message: 'Synthetic failure' } }, /failed|失败/]
]) test('existing force-release button and runtime agree on ' + name, async () => {
  const logs = [], context = vm.createContext({ currentRunView: null, getCurrentProjectId: () => 'project-one',
    tx: en => en, localizeVisibleReason: value => value, appendPlainLog: text => logs.push(text), sendBackgroundNative: async () => response,
    Modules: productionModules() });
  vm.runInContext(extractFunction(source, 'forceCancelStuckTaskForCurrentProject'), context);
  const actions = Actions.create({ document: { createElement: () => new Element() }, tx: en => en,
    forceCancelStuckTaskForCurrentProject: context.forceCancelStuckTaskForCurrentProject });
  const report = new Element(); actions.appendRecoveryActionForFailure(report, { failure: { code: 'codex_project_locked' } }, {});
  const button = report.children[0]; button.listeners.click({ stopPropagation() {} }); await flush();
  assert.match(button.textContent, expected); assert.match(logs[0], expected);
  if (name !== 'lock released') { assert.doesNotMatch(button.textContent, /^Force-released/); assert.doesNotMatch(logs[0], /^Force-released/); }
});

test('force cancel acknowledgement uses the existing Chinese locale without overstating progress', () => {
  const tx = (_en, zh) => zh;
  assert.match(Actions.formatForceCancelOutcome({ ok: true, result: { sent: true } }, tx), /已发送.*尚未确认/);
  assert.match(Actions.formatForceCancelOutcome({ ok: true, result: { cancelled: true } }, tx), /请求取消.*等待/);
  assert.doesNotMatch(Actions.formatForceCancelOutcome({ ok: true, result: {} }, tx), /已发送|已释放/);
});
