const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const I18n = require('../extension/src/shared/i18n');
const SessionState = require('../extension/src/shared/sessionState');

for (const surface of ['project', 'dashboard']) {
  for (const locale of ['en', 'zh']) {
    for (const external of [false, true]) {
      test(`${surface} session deletion localizes missing Native failure details in ${locale}, external=${external}`, async () => {
        const toasts = [];
        const requests = [];
        const target = { ...SessionState.createSession(), id: 'delete-target', task: 'A saved task', codexThreadId: 'thread-target' };
        let state = { sessions: [target, { ...SessionState.createSession(), id: 'retained-session' }], activeSessionId: target.id };
        const externalMessage = '原始诊断 external failure';
        const context = {
          tr: (key, params) => I18n.t(locale, key, params),
          showPluginConfirm: async () => true,
          showPluginToast: (message, options) => toasts.push({ message, options }),
          sendBackgroundNative: async request => { requests.push(request); return { ok: false, ...(external ? { error: { message: externalMessage } } : {}) }; },
          getState: () => state,
          setState: next => { state = next; },
          deleteSession: SessionState.deleteSession,
          SessionState,
          isSessionRunning: () => false,
          isDisplayableSession: () => true,
          getSessionDisplayTitle: () => target.task,
          sessionRecordDisplayTitle: () => target.task,
          saveState: async () => {},
          applyStateToPanel() {},
          StorageDb: { derivePrimaryStatusBadge: () => 'completed', deleteRecord: async () => {} },
          SessionPersistence: { addTombstones: async () => {} },
          mutateProjectPanelState: async (_project, mutate) => { state = mutate(state); },
          refreshDashboardView: async () => {}
        };
        const file = surface === 'project' ? 'sessionManager.js' : 'recentProjects.js';
        const name = surface === 'project' ? 'deleteSessionWithConfirm' : 'deleteDashboardSession';
        const source = fs.readFileSync(path.join(__dirname, '../extension/src/content', file), 'utf8');
        const run = vm.runInNewContext('(' + extractFunction(source, name) + ')', context);
        if (surface === 'project') await run(target.id);
        else await run(null, 'project-id', target);
        const detail = external ? externalMessage : locale === 'zh'
          ? '本地桥接程序未确认操作成功。' : 'The local bridge did not confirm success.';
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].message, I18n.t(locale, 'deleteSessionHistoryFailedToast', { message: detail }));
        assert.equal(toasts[0].options.status, 'warning');
        assert.equal(state.sessions.some(session => session.id === target.id), false);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, 'codex.history.clearPlugin');
        assert.equal(requests[0].params.threadId, 'thread-target');
      });
    }
  }
}
