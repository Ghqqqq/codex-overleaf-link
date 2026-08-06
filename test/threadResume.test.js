const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildThreadStartParams,
  buildThreadResumeParams,
  buildTurnStartParams,
  buildCodexSettings
} = require('../native-host/src/codexSessionRunner');

test('buildThreadStartParams does not include threadId', () => {
  const params = buildThreadStartParams({
    workspacePath: '/tmp/ws',
    model: 'gpt-5.4',
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write'
  });
  assert.strictEqual(params.cwd, '/tmp/ws');
  assert.strictEqual(params.model, 'gpt-5.4');
  assert.strictEqual(params.approvalPolicy, 'never');
  assert.strictEqual(params.sandbox, 'workspace-write');
  assert.strictEqual(params.threadId, undefined);
});

test('buildThreadResumeParams includes threadId', () => {
  const params = buildThreadResumeParams({
    threadId: 'thread_abc123',
    workspacePath: '/tmp/ws',
    model: 'gpt-5.4',
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write'
  });
  assert.strictEqual(params.threadId, 'thread_abc123');
  assert.strictEqual(params.cwd, '/tmp/ws');
  assert.strictEqual(params.model, 'gpt-5.4');
  assert.strictEqual(params.approvalPolicy, 'never');
  assert.strictEqual(params.sandbox, 'workspace-write');
});

test('buildThreadResumeParams with empty threadId', () => {
  const params = buildThreadResumeParams({
    threadId: '',
    workspacePath: '/tmp/ws'
  });
  assert.strictEqual(params.threadId, '');
  assert.strictEqual(params.cwd, '/tmp/ws');
});

test('buildThreadResumeParams defaults model to null', () => {
  const params = buildThreadResumeParams({
    threadId: 'thread_xyz',
    workspacePath: '/tmp/ws'
  });
  assert.strictEqual(params.model, null);
});

test('buildTurnStartParams requests detailed reasoning summaries for supported models', () => {
  const params = buildTurnStartParams({
    threadId: 'thread_abc123',
    workspacePath: '/tmp/ws',
    task: 'check grammar',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh'
  });

  assert.strictEqual(params.threadId, 'thread_abc123');
  assert.strictEqual(params.cwd, '/tmp/ws');
  assert.strictEqual(params.model, 'gpt-5.5');
  assert.strictEqual(params.effort, 'xhigh');
  assert.strictEqual(params.summary, 'detailed');
});

test('buildTurnStartParams preserves max and ultra reasoning tiers', () => {
  const maxParams = buildTurnStartParams({
    threadId: 'thread_max',
    workspacePath: '/tmp/ws',
    task: 'solve a hard problem',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max'
  });
  const ultraParams = buildTurnStartParams({
    threadId: 'thread_ultra',
    workspacePath: '/tmp/ws',
    task: 'delegate a hard problem',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'ultra'
  });

  assert.strictEqual(maxParams.effort, 'max');
  assert.strictEqual(ultraParams.effort, 'ultra');
});

test('buildTurnStartParams omits reasoning summary for gpt-5.3-codex-spark', () => {
  const params = buildTurnStartParams({
    threadId: 'thread_spark',
    workspacePath: '/tmp/ws',
    task: 'check grammar',
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'xhigh'
  });

  assert.strictEqual(params.threadId, 'thread_spark');
  assert.strictEqual(params.model, 'gpt-5.3-codex-spark');
  assert.strictEqual(params.effort, 'xhigh');
  assert.strictEqual(Object.hasOwn(params, 'summary'), false);
});
