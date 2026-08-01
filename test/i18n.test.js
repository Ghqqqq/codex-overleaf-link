const assert = require('node:assert/strict');
const test = require('node:test');

const I18n = require('../extension/src/shared/i18n');

test('i18n defaults to English and toggles between English and Chinese', () => {
  assert.equal(I18n.normalizeLocale(), 'en');
  assert.equal(I18n.normalizeLocale('en'), 'en');
  assert.equal(I18n.normalizeLocale('zh'), 'zh');
  assert.equal(I18n.normalizeLocale('fr'), 'en');
  assert.equal(I18n.getOppositeLocale('en'), 'zh');
  assert.equal(I18n.getOppositeLocale('zh'), 'en');
});

test('language switch label describes the target language', () => {
  assert.equal(I18n.t('en', 'switchLanguage'), 'Switch to Chinese');
  assert.equal(I18n.t('zh', 'switchLanguage'), '切换为英文');
});

test('i18n keeps internal mode ids while translating labels', () => {
  assert.equal(I18n.t('en', 'modeAsk'), 'Ask');
  assert.equal(I18n.t('en', 'modeAuto'), 'Auto');
  assert.equal(I18n.t('zh', 'modeAsk'), '只问不改');
  assert.equal(I18n.t('zh', 'modeAuto'), '自动写入');
});

test('i18n covers plugin dialogs, diff review, toasts, and undo actions', () => {
  assert.equal(I18n.t('en', 'confirmBrand'), 'Codex Confirm');
  assert.equal(I18n.t('zh', 'confirmBrand'), 'Codex 确认');
  assert.equal(I18n.t('en', 'deleteSessionTitle'), 'Delete this Codex session?');
  assert.equal(I18n.t('zh', 'deleteSessionTitle'), '删除这个 Codex 会话？');
  assert.equal(I18n.t('en', 'diffAcceptAll'), 'Accept all');
  assert.equal(I18n.t('zh', 'diffAcceptAll'), '接受全部');
  assert.equal(I18n.t('en', 'diffHunkAccept'), 'Accept hunk');
  assert.equal(I18n.t('zh', 'diffHunkAccept'), '接受此段');
  assert.equal(I18n.t('en', 'diffHunkReject'), 'Reject hunk');
  assert.equal(I18n.t('zh', 'diffHunkReject'), '拒绝此段');
  assert.equal(I18n.t('en', 'diffHunkJump'), 'Jump to hunk');
  assert.equal(I18n.t('zh', 'diffHunkJump'), '跳到此段');
  assert.equal(I18n.t('en', 'diffHunkAccepted'), 'Hunk accepted');
  assert.equal(I18n.t('zh', 'diffHunkAccepted'), '此段已接受');
  assert.equal(I18n.t('en', 'diffHunkRejected'), 'Hunk rejected');
  assert.equal(I18n.t('zh', 'diffHunkRejected'), '此段已拒绝');
  assert.equal(I18n.t('en', 'diffFallbackFileOnly'), 'Review at file level');
  assert.equal(I18n.t('zh', 'diffFallbackFileOnly'), '按文件确认');
  assert.equal(I18n.t('en', 'undoRun'), 'Undo changes');
  assert.equal(I18n.t('zh', 'undoRun'), '撤销改动');
  assert.equal(I18n.t('en', 'undoApplied'), 'Undone');
  assert.equal(I18n.t('zh', 'undoApplied'), '已撤销');
  assert.equal(I18n.t('en', 'dismissNotification'), 'Dismiss notification');
  assert.equal(I18n.t('zh', 'dismissNotification'), '关闭通知');
});

test('i18n covers warm mirror run status copy', () => {
  assert.equal(
    I18n.t('en', 'warmMirrorReuseTitle'),
    'Using the warmed local workspace. No Overleaf editor navigation was needed before this run.'
  );
  assert.equal(
    I18n.t('zh', 'warmMirrorReuseTitle'),
    '使用已预热的本地 workspace；本轮开始前没有导航 Overleaf 编辑器。'
  );
  assert.match(I18n.t('en', 'warmMirrorPartialOverlayTitle'), /current-file overlay/);
  assert.match(I18n.t('zh', 'warmMirrorFocusOverlayTitle'), /焦点文件差异/);
  assert.match(I18n.t('en', 'warmMirrorStaleRetryTitle'), /fresh full sync/);
  assert.match(I18n.t('zh', 'warmMirrorStaleBlockedTitle'), /本地 workspace 过期/);
});
