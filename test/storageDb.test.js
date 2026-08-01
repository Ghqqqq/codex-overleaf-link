const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TARGET_SCHEMA_VERSION,
  DB_NAME,
  STORES,
  buildSessionRecord,
  buildTurnRecord,
  buildEventRecord,
  buildArtifactRecord,
  buildAuditLogRecord,
  extractLightweightPrefs,
  buildActiveSessionByProject,
  filterRecentProjectsAcrossAccount,
  derivePrimaryStatusBadge
} = require('../extension/src/shared/storageDb');
const { normalizeRuns, prepareStateForStorage } = require('../extension/src/shared/sessionState');

test('TARGET_SCHEMA_VERSION is a positive integer', () => {
  assert.equal(typeof TARGET_SCHEMA_VERSION, 'number');
  assert.ok(TARGET_SCHEMA_VERSION > 0);
  assert.equal(TARGET_SCHEMA_VERSION, Math.floor(TARGET_SCHEMA_VERSION));
  assert.equal(TARGET_SCHEMA_VERSION, 3, 'released IndexedDB schema versions must never move backwards');
});

test('DB_NAME is codex-overleaf', () => {
  assert.equal(DB_NAME, 'codex-overleaf');
});

test('STORES has auditLogs store with correct structure', () => {
  const storeNames = Object.keys(STORES);
  assert.deepEqual(storeNames.sort(), ['artifacts', 'auditLogs', 'events', 'sessions', 'turns']);

  // sessions store
  assert.equal(STORES.sessions.keyPath, 'id');
  assert.deepEqual(Object.keys(STORES.sessions.indexes).sort(), ['projectId', 'updatedAt']);
  assert.equal(STORES.sessions.indexes.projectId.keyPath, 'projectId');
  assert.equal(STORES.sessions.indexes.updatedAt.keyPath, 'updatedAt');

  // turns store
  assert.equal(STORES.turns.keyPath, 'id');
  assert.deepEqual(Object.keys(STORES.turns.indexes).sort(), ['createdAt', 'sessionId']);
  assert.equal(STORES.turns.indexes.sessionId.keyPath, 'sessionId');
  assert.equal(STORES.turns.indexes.createdAt.keyPath, 'createdAt');

  // events store
  assert.equal(STORES.events.keyPath, 'id');
  assert.deepEqual(Object.keys(STORES.events.indexes).sort(), ['index', 'turnId']);
  assert.equal(STORES.events.indexes.turnId.keyPath, 'turnId');
  assert.equal(STORES.events.indexes.index.keyPath, 'index');

  // artifacts store
  assert.equal(STORES.artifacts.keyPath, 'id');
  assert.deepEqual(Object.keys(STORES.artifacts.indexes).sort(), ['turnId', 'type']);
  assert.equal(STORES.artifacts.indexes.turnId.keyPath, 'turnId');
  assert.equal(STORES.artifacts.indexes.type.keyPath, 'type');

  assert.equal(STORES.auditLogs.keyPath, 'id');
  assert.deepEqual(Object.keys(STORES.auditLogs.indexes).sort(), ['createdAt', 'projectId']);
  assert.equal(STORES.auditLogs.indexes.projectId.keyPath, 'projectId');
  assert.equal(STORES.auditLogs.indexes.createdAt.keyPath, 'createdAt');
});

test('STORES indexes all have unique: false', () => {
  for (const storeName of Object.keys(STORES)) {
    const indexes = STORES[storeName].indexes;
    for (const indexName of Object.keys(indexes)) {
      assert.equal(indexes[indexName].unique, false,
        `${storeName}.${indexName} should have unique: false`);
    }
  }
});

test('buildSessionRecord normalizes with defaults', () => {
  const record = buildSessionRecord({ id: 'ses_1', projectId: 'proj_1' });
  assert.equal(record.id, 'ses_1');
  assert.equal(record.projectId, 'proj_1');
  assert.equal(record.title, '');
  assert.equal(record.codexThreadId, '');
  assert.equal(record.status, 'active');
  assert.deepEqual(record.focusFiles, []);
  assert.ok(typeof record.createdAt === 'string' && record.createdAt.length > 0);
  assert.ok(typeof record.updatedAt === 'string' && record.updatedAt.length > 0);
});

test('buildSessionRecord preserves provided values', () => {
  const input = {
    id: 'ses_custom',
    projectId: 'proj_2',
    title: 'My Session',
    titleSource: 'manual',
    codexThreadId: 'thread_abc',
    status: 'completed',
    focusFiles: ['main.tex', 'intro.tex'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z'
  };
  const record = buildSessionRecord(input);
  assert.equal(record.id, 'ses_custom');
  assert.equal(record.projectId, 'proj_2');
  assert.equal(record.title, 'My Session');
  assert.equal(record.codexThreadId, 'thread_abc');
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.focusFiles, ['main.tex', 'intro.tex']);
  assert.equal(record.createdAt, '2025-01-01T00:00:00.000Z');
  assert.equal(record.updatedAt, '2025-01-02T00:00:00.000Z');
});

test('buildSessionRecord preserves reloadable session display text while stripping bulky unsafe payloads', () => {
  const rawPrompt = 'STORAGE_DB_PROMPT_SHOULD_NOT_PERSIST';
  const rawOutput = 'STORAGE_DB_OUTPUT_SHOULD_NOT_PERSIST';
  const rawCompileLog = 'STORAGE_DB_COMPILE_LOG_SHOULD_NOT_PERSIST';
  const rawDiff = 'STORAGE_DB_RAW_DIFF_SHOULD_NOT_PERSIST';
  const rawProjectText = 'STORAGE_DB_PROJECT_TEXT_SHOULD_NOT_PERSIST';
  const finalReport = [
    '结论：这轮历史刷新后应该仍然可读。',
    '',
    '1. 保留用户问题。',
    '2. 保留最终回答。'
  ].join('\n');
  const input = {
    id: 'ses_stateful',
    projectId: 'proj_stateful',
    title: 'Check grammar',
    titleSource: 'manual',
    task: rawPrompt,
    mode: 'auto',
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'xhigh',
    speedTier: 'fast',
    requireReviewing: false,
    history: [{ task: rawPrompt, result: rawOutput, at: '2026-05-02T01:00:00.000Z' }],
    runs: [{
      id: 'run_1',
      task: rawPrompt,
      status: 'failed',
      statusText: rawOutput,
      startedAt: '2026-05-02T01:00:00.000Z',
      finishedAt: '2026-05-02T01:01:00.000Z',
      events: [{
        title: '本轮完成报告',
        status: 'completed',
        kind: 'report',
        detail: finalReport
      }, {
        title: rawCompileLog,
        status: 'failed',
        kind: 'activity',
        detail: {
          compileLog: rawCompileLog,
          rawDiff,
          projectText: rawProjectText,
          path: 'main.tex'
        }
      }],
      attachments: [{
        name: 'figure.png',
        mimeType: 'image/png',
        size: 128,
        kind: 'image',
        previewDataUrl: 'data:image/png;base64,STORAGE_DB_IMAGE_SHOULD_NOT_PERSIST'
      }],
      undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: rawDiff }],
      undoBaseFiles: [{ path: 'main.tex', content: rawProjectText }],
      undoExpectedFiles: [{ path: 'main.tex', content: rawProjectText }]
    }]
  };

  const record = buildSessionRecord(input);
  const serialized = JSON.stringify(record);

  for (const forbidden of [
    rawDiff,
    rawProjectText,
    'data:image/png;base64,STORAGE_DB_IMAGE_SHOULD_NOT_PERSIST'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `buildSessionRecord leaked ${forbidden}`);
  }

  assert.equal(record.title, 'Check grammar');
  assert.equal(record.task, rawPrompt);
  assert.equal(record.mode, 'auto');
  assert.equal(record.model, 'gpt-5.3-codex-spark');
  assert.equal(record.reasoningEffort, 'xhigh');
  assert.equal(record.speedTier, 'fast');
  assert.equal(record.requireReviewing, false);
  assert.equal(record.history[0].task, rawPrompt);
  assert.equal(record.history[0].result, rawOutput);
  assert.equal(record.runs[0].status, 'failed');
  assert.equal(record.runs[0].task, rawPrompt);
  assert.equal(record.runs[0].statusText, rawOutput);
  assert.equal(record.runs[0].startedAt, '2026-05-02T01:00:00.000Z');
  assert.equal(record.runs[0].events[0].title, '本轮完成报告');
  assert.equal(record.runs[0].events[0].detail, finalReport);
  assert.equal(record.runs[0].events[1].title, rawCompileLog);
  assert.equal(record.runs[0].events[1].detail.redacted, true);
  assert.deepEqual(record.runs[0].events[1].detail.paths, ['main.tex']);
  assert.deepEqual(record.runs[0].attachments, [{
    name: 'figure.png',
    mimeType: 'image/png',
    size: 128,
    kind: 'image'
  }]);
  assert.equal(record.runs[0].undoOperations.length, 0);
});

test('buildSessionRecord keeps a valid trackedChangeStatus while still dropping the heavy tracked-change payload', () => {
  const rawProjectText = 'STORAGE_DB_TRACKED_CHANGE_TEXT_SHOULD_NOT_PERSIST';
  const record = buildSessionRecord({
    id: 'ses_tracked_change',
    projectId: 'proj_tracked_change',
    runs: [{
      id: 'run_tc_accepted',
      task: 'accepted tracked change run',
      status: 'completed',
      trackedChangeStatus: 'accepted',
      undoTrackedChanges: [{ key: 'tc-1', id: 'change-1', path: 'main.tex', label: 'Change 1' }],
      undoExpectedFiles: [{ path: 'main.tex', content: rawProjectText }]
    }, {
      id: 'run_tc_invalid',
      task: 'invalid tracked change run',
      status: 'completed',
      trackedChangeStatus: 'accepting'
    }]
  });

  const accepted = record.runs.find(run => run.id === 'run_tc_accepted');
  const invalid = record.runs.find(run => run.id === 'run_tc_invalid');

  assert.equal(accepted.trackedChangeStatus, 'accepted');
  assert.deepEqual(accepted.undoTrackedChanges, []);
  assert.deepEqual(accepted.undoExpectedFiles, []);
  assert.equal(JSON.stringify(record).includes(rawProjectText), false);
  assert.equal('trackedChangeStatus' in invalid, false);
});

test('trusted IndexedDB session records preserve a bounded tracked-change action checkpoint across reload', () => {
  const record = buildSessionRecord({
    id: 'ses_reloadable_tracked_change',
    projectId: 'proj_reloadable_tracked_change',
    runs: [{
      id: 'run_reloadable_tracked_change',
      task: 'reloadable tracked change run',
      status: 'completed',
      trackedChangeStatus: 'pending',
      runProjectId: 'proj_reloadable_tracked_change',
      appliedOperations: [{
        type: 'edit',
        path: 'main.tex',
        patches: [{ from: 0, to: 3, expected: 'old', insert: 'new' }],
        verifiedContent: 'new'
      }],
      undoTrackedChanges: [{ key: 'tc-1', id: 'change-1', path: 'main.tex', label: 'Change 1' }],
      undoExpectedFiles: [{ path: 'main.tex', content: 'old' }]
    }]
  }, { preserveRunActionPayload: true });

  const persisted = record.runs[0];
  assert.equal(persisted.trackedChangeStatus, 'pending');
  assert.equal(persisted.appliedOperations.length, 1);
  assert.equal(persisted.undoTrackedChanges.length, 1);
  assert.equal(persisted.undoExpectedFiles.length, 1);

  const reloaded = normalizeRuns(record.runs)[0];
  assert.equal(reloaded.trackedChangeStatus, 'pending');
  assert.equal(reloaded.appliedOperations.length, 1);
  assert.equal(reloaded.undoTrackedChanges.length, 1);
  assert.equal(reloaded.undoExpectedFiles.length, 1);
});

test('auto session titles are not persisted as raw prompt snippets while manual titles remain', () => {
  const rawPrompt = 'AUTO_TITLE_PROMPT_SHOULD_NOT_PERSIST rewrite the whole introduction';
  const compact = prepareStateForStorage({
    activeSessionId: 'session_auto_title',
    sessions: [{
      id: 'session_auto_title',
      title: rawPrompt,
      titleSource: 'auto',
      task: rawPrompt,
      runs: [{
        id: 'run_auto_title',
        task: rawPrompt,
        status: 'completed'
      }]
    }, {
      id: 'session_manual_title',
      title: 'Manual Literature Review Pass',
      titleSource: 'manual',
      task: rawPrompt,
      runs: []
    }]
  });
  const autoRecord = buildSessionRecord({
    ...compact.sessions.find(session => session.id === 'session_auto_title'),
    projectId: 'proj_title'
  });
  const manualRecord = buildSessionRecord({
    ...compact.sessions.find(session => session.id === 'session_manual_title'),
    projectId: 'proj_title'
  });

  assert.equal(JSON.stringify(compact).includes(rawPrompt), false);
  assert.equal(JSON.stringify(autoRecord).includes(rawPrompt), false);
  assert.notEqual(autoRecord.title, rawPrompt);
  assert.equal(manualRecord.title, 'Manual Literature Review Pass');
});

test('IndexedDB session-record boundary does not persist local absolute paths from compact state', () => {
  const rawLocalPath = '/Users/alice/.codex-overleaf/projects/project-a/workspace/main.tex:117';
  const rawLocalPathColumn = '/Users/alice/.codex-overleaf/projects/project-a/workspace/main.tex:117:9';
  const compact = prepareStateForStorage({
    activeSessionId: 'session_local_path_boundary',
    sessions: [{
      id: 'session_local_path_boundary',
      title: `Local path boundary ${rawLocalPath}`,
      titleSource: 'manual',
      task: `Inspect ${rawLocalPath}`,
      history: [{
        task: `History task ${rawLocalPath}`,
        result: `History result ${rawLocalPathColumn}`,
        at: '2026-05-06T00:00:00.000Z'
      }],
      runs: [{
        id: 'run_local_path_boundary',
        task: `Run task ${rawLocalPath}`,
        status: 'completed',
        statusText: `Done with ${rawLocalPath}`,
        events: [{
          title: `Final answer ${rawLocalPath}`,
          status: 'completed',
          kind: 'report',
          detail: {
            userReport: `Report ${rawLocalPath}`,
            assistantMessage: `Assistant ${rawLocalPathColumn}`,
            path: rawLocalPath
          }
        }]
      }]
    }]
  });

  const record = buildSessionRecord({
    ...compact.sessions[0],
    projectId: 'proj_local_path_boundary'
  });
  const serialized = JSON.stringify(record);

  for (const forbidden of [
    '/Users/alice',
    '.codex-overleaf/projects/project-a',
    rawLocalPath,
    rawLocalPathColumn
  ]) {
    assert.equal(serialized.includes(forbidden), false, `session record leaked ${forbidden}`);
  }
});

test('buildSessionRecord directly sanitizes local line refs including inline and fenced code', () => {
  const rawLocalPath = '/Users/alice/.codex-overleaf/projects/project-a/workspace/main.tex:117';
  const rawLocalPathColumn = '/Users/alice/.codex-overleaf/projects/project-a/workspace/main.tex:117:9';
  const record = buildSessionRecord({
    id: 'session_raw_boundary',
    projectId: 'proj_raw_boundary',
    title: `Raw title ${rawLocalPath}`,
    titleSource: 'manual',
    task: `Inspect ${rawLocalPath}`,
    focusFiles: [rawLocalPath],
    history: [{
      task: `History task ${rawLocalPath}`,
      result: [
        `Inline \`${rawLocalPath}\``,
        '```',
        rawLocalPathColumn,
        '```'
      ].join('\n'),
      at: '2026-05-06T00:00:00.000Z'
    }],
    runs: [{
      id: 'run_raw_boundary',
      task: `Run task ${rawLocalPath}`,
      status: 'completed',
      statusText: `Done ${rawLocalPath}`,
      events: [{
        title: `Event ${rawLocalPath}`,
        status: 'completed',
        kind: 'report',
        detail: [
          `Inline \`${rawLocalPath}\``,
          '```',
          rawLocalPathColumn,
          '```'
        ].join('\n')
      }]
    }]
  });
  const serialized = JSON.stringify(record);

  for (const forbidden of [
    '/Users/alice',
    '.codex-overleaf/projects/project-a',
    rawLocalPath,
    rawLocalPathColumn
  ]) {
    assert.equal(serialized.includes(forbidden), false, `raw session record leaked ${forbidden}`);
  }
  assert.match(serialized, /local path:117/);
});

test('buildSessionRecord generates id when not provided', () => {
  const record = buildSessionRecord({ projectId: 'proj_3' });
  assert.ok(record.id.startsWith('ses_'));
  assert.ok(record.id.length > 4);
});

test('buildTurnRecord normalizes with defaults', () => {
  const record = buildTurnRecord({ id: 'turn_1', sessionId: 'ses_1' });
  assert.equal(record.id, 'turn_1');
  assert.equal(record.sessionId, 'ses_1');
  assert.equal(record.task, '');
  assert.equal(record.mode, '');
  assert.equal(record.model, '');
  assert.equal(record.reasoningEffort, '');
  assert.equal(record.speedTier, '');
  assert.ok(typeof record.createdAt === 'string' && record.createdAt.length > 0);
  assert.equal(record.completedAt, '');
  assert.equal(record.finalSummary, '');
});

test('buildTurnRecord preserves metadata and summarizes body fields', () => {
  const input = {
    id: 'turn_x',
    sessionId: 'ses_x',
    task: 'Fix the bug',
    mode: 'auto',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    speedTier: 'fast',
    createdAt: '2025-03-01T00:00:00.000Z',
    completedAt: '2025-03-01T00:05:00.000Z',
    finalSummary: 'Bug fixed successfully'
  };
  const record = buildTurnRecord(input);
  assert.equal(record.id, 'turn_x');
  assert.equal(record.sessionId, 'ses_x');
  assert.match(record.task, /^\[turn task omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
  assert.equal(record.mode, 'auto');
  assert.equal(record.model, 'gpt-5.4');
  assert.equal(record.reasoningEffort, 'high');
  assert.equal(record.speedTier, 'fast');
  assert.equal(record.createdAt, '2025-03-01T00:00:00.000Z');
  assert.equal(record.completedAt, '2025-03-01T00:05:00.000Z');
  assert.match(record.finalSummary, /^\[turn summary omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
});

test('buildTurnRecord summarizes prompt and final summary bodies', () => {
  const rawPrompt = 'TURN_PROMPT_SHOULD_NOT_PERSIST';
  const rawSummary = 'TURN_FINAL_SUMMARY_SHOULD_NOT_PERSIST';
  const record = buildTurnRecord({
    id: 'turn_privacy',
    sessionId: 'ses_privacy',
    task: rawPrompt,
    finalSummary: rawSummary
  });
  const serialized = JSON.stringify(record);

  assert.equal(serialized.includes(rawPrompt), false);
  assert.equal(serialized.includes(rawSummary), false);
  assert.match(record.task, /^\[turn task omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
  assert.match(record.finalSummary, /^\[turn summary omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
});

test('buildTurnRecord generates id when not provided', () => {
  const record = buildTurnRecord({ sessionId: 'ses_1' });
  assert.ok(record.id.startsWith('turn_'));
});

test('buildEventRecord normalizes with defaults', () => {
  const record = buildEventRecord({ id: 'evt_1', turnId: 'turn_1' });
  assert.equal(record.id, 'evt_1');
  assert.equal(record.turnId, 'turn_1');
  assert.equal(record.index, 0);
  assert.equal(record.kind, '');
  assert.equal(record.text, '');
  assert.equal(record.detail, null);
  assert.ok(typeof record.createdAt === 'string' && record.createdAt.length > 0);
});

test('buildEventRecord preserves metadata and summarizes body fields', () => {
  const input = {
    id: 'evt_x',
    turnId: 'turn_x',
    index: 5,
    kind: 'file_edit',
    text: 'Edited main.tex',
    detail: { path: 'main.tex' },
    createdAt: '2025-04-01T00:00:00.000Z'
  };
  const record = buildEventRecord(input);
  assert.equal(record.id, 'evt_x');
  assert.equal(record.turnId, 'turn_x');
  assert.equal(record.index, 5);
  assert.equal(record.kind, 'file_edit');
  assert.match(record.text, /^\[event text omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
  assert.equal(record.detail.redacted, true);
  assert.deepEqual(record.detail.paths, ['main.tex']);
  assert.equal(record.createdAt, '2025-04-01T00:00:00.000Z');
});

test('buildEventRecord summarizes text and structured detail bodies', () => {
  const rawText = 'EVENT_TEXT_SHOULD_NOT_PERSIST';
  const rawCompileLog = 'EVENT_COMPILE_LOG_SHOULD_NOT_PERSIST';
  const rawProjectText = 'EVENT_PROJECT_TEXT_SHOULD_NOT_PERSIST';
  const record = buildEventRecord({
    id: 'evt_privacy',
    turnId: 'turn_privacy',
    index: 1,
    kind: 'stream',
    text: rawText,
    detail: {
      compileLog: rawCompileLog,
      projectText: rawProjectText,
      path: 'main.tex'
    }
  });
  const serialized = JSON.stringify(record);

  for (const forbidden of [rawText, rawCompileLog, rawProjectText]) {
    assert.equal(serialized.includes(forbidden), false, `buildEventRecord leaked ${forbidden}`);
  }
  assert.match(record.text, /^\[event text omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
  assert.deepEqual(record.detail.paths, ['main.tex']);
});

test('buildEventRecord generates id when not provided', () => {
  const record = buildEventRecord({ turnId: 'turn_1', index: 0 });
  assert.ok(record.id.startsWith('evt_'));
});

test('buildArtifactRecord normalizes with defaults', () => {
  const record = buildArtifactRecord({ id: 'art_1', turnId: 'turn_1' });
  assert.equal(record.id, 'art_1');
  assert.equal(record.turnId, 'turn_1');
  assert.equal(record.type, '');
  assert.equal(record.path, '');
  assert.equal(record.payload, null);
  assert.ok(typeof record.createdAt === 'string' && record.createdAt.length > 0);
});

test('buildArtifactRecord preserves metadata and summarizes payload fields', () => {
  const input = {
    id: 'art_x',
    turnId: 'turn_x',
    type: 'file',
    path: 'output/result.pdf',
    payload: { size: 1024 },
    createdAt: '2025-05-01T00:00:00.000Z'
  };
  const record = buildArtifactRecord(input);
  assert.equal(record.id, 'art_x');
  assert.equal(record.turnId, 'turn_x');
  assert.equal(record.type, 'file');
  assert.equal(record.path, 'output/result.pdf');
  assert.equal(record.payload.redacted, true);
  assert.equal(record.payload.type, 'object');
  assert.equal(record.createdAt, '2025-05-01T00:00:00.000Z');
});

test('buildArtifactRecord summarizes raw payload bodies', () => {
  const rawPayload = 'ARTIFACT_PAYLOAD_SHOULD_NOT_PERSIST';
  const record = buildArtifactRecord({
    id: 'art_privacy',
    turnId: 'turn_privacy',
    type: 'diagnostic',
    path: 'diagnostics.json',
    payload: {
      output: rawPayload,
      path: 'main.tex'
    }
  });
  const serialized = JSON.stringify(record);

  assert.equal(serialized.includes(rawPayload), false);
  assert.equal(record.payload.redacted, true);
  assert.deepEqual(record.payload.paths, ['main.tex']);
});

test('buildArtifactRecord generates id when not provided', () => {
  const record = buildArtifactRecord({ turnId: 'turn_1', type: 'file' });
  assert.ok(record.id.startsWith('art_'));
});

test('buildAuditLogRecord normalizes summary-only audit fields', () => {
  const record = buildAuditLogRecord({
    id: 'aud_1',
    projectId: 'proj',
    sessionId: 'ses',
    turnId: 'turn',
    promptSummary: 'Fix intro',
    focusFiles: ['main.tex'],
    selectedSkillIds: ['style'],
    sensitiveFindings: [{ detectorId: 'private-key', path: 'keys.txt', preview: '[REDACTED]' }],
    changedFiles: [{ path: 'main.tex', content: 'body' }],
    diffSummary: { filesChanged: 1, additions: 2, deletions: 1 },
    blockedFiles: [{ path: 'locked.tex', reason: 'readonly', content: 'blocked' }],
    appliedFiles: ['main.tex'],
    skippedFiles: [{ path: 'raw.bin', reason: 'unsupported' }],
    resultStatus: 'blocked',
    createdAt: '2026-05-06T00:00:00.000Z',
    completedAt: '2026-05-06T00:01:00.000Z'
  });

  assert.equal(record.id, 'aud_1');
  assert.equal(record.projectId, 'proj');
  assert.equal(record.resultStatus, 'blocked');
  assert.deepEqual(record.changedFiles, [{ path: 'main.tex' }]);
  assert.deepEqual(record.blockedFiles, [{ path: 'locked.tex', reason: 'readonly' }]);
  assert.deepEqual(record.appliedFiles, [{ path: 'main.tex' }]);
  assert.equal(JSON.stringify(record).includes('body'), false);
});

test('buildAuditLogRecord does not persist raw sensitive finding previews', () => {
  const record = buildAuditLogRecord({
    id: 'aud_preview',
    projectId: 'proj',
    sensitiveFindings: [{
      detectorId: 'redacted-secret',
      path: 'main.tex',
      source: 'project',
      preview: 'PROJECT LINE SHOULD NOT PERSIST [REDACTED_SECRET]'
    }]
  });
  const serialized = JSON.stringify(record);

  assert.equal(serialized.includes('PROJECT LINE SHOULD NOT PERSIST'), false);
  assert.match(record.sensitiveFindings[0].preview, /^\[sensitive preview omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
});

test('buildAuditLogRecord summarizes raw prompt summaries at the storage boundary', () => {
  const rawPrompt = 'AUDIT_PROMPT_SHOULD_NOT_PERSIST rewrite the whole introduction';
  const record = buildAuditLogRecord({
    id: 'aud_prompt_privacy',
    projectId: 'proj',
    promptSummary: rawPrompt
  });
  const serialized = JSON.stringify(record);

  assert.equal(serialized.includes(rawPrompt), false);
  assert.match(record.promptSummary, /^\[audit prompt omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
});

test('buildAuditLogRecord summarizes raw save verification blobs', () => {
  const rawOutput = 'AUDIT_SAVE_OUTPUT_SHOULD_NOT_PERSIST';
  const record = buildAuditLogRecord({
    id: 'aud_save_privacy',
    projectId: 'proj',
    saveVerification: {
      status: 'failed',
      ok: false,
      stdout: rawOutput,
      stderr: rawOutput,
      commandOutput: rawOutput,
      raw: rawOutput,
      message: rawOutput,
      diagnostics: {
        status: 'failed',
        errorCode: 'latex_failed',
        stdout: rawOutput
      }
    }
  });
  const serialized = JSON.stringify(record);

  assert.equal(serialized.includes(rawOutput), false);
  assert.deepEqual(record.saveVerification, {
    status: 'failed',
    ok: false,
    errorCategory: 'error',
    diagnostics: {
      status: 'failed',
      errorCode: 'latex_failed',
      errorCategory: 'error'
    }
  });
});

test('extractLightweightPrefs extracts correct fields', () => {
  const state = {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    speedTier: 'fast',
    mode: 'confirm',
    locale: 'zh',
    requireReviewing: true,
    autoRecompile: true,
    loadCodexLocalSkills: false,
    loadCodexOverleafSkills: true,
    panelWidth: 512,
    activeSessionByProject: { proj_1: 'ses_1' },
    experimentalOtByProject: { proj_1: true, proj_2: false },
    customInstructionsByProject: {
      proj_1: 'Use project terminology.',
      proj_2: 'Prefer concise edits.'
    },
    governanceRulesByProject: {
      proj_1: {
        readonlyPatterns: [' locked/** ', 123],
        writablePatterns: ['main.tex'],
        sensitiveCheckEnabled: false,
        sensitiveConfirmAllowed: true
      }
    },
    selectedLocalSkillIdsByProject: {
      proj_1: ['style', 'style', 'citations', 42]
    },
    extraField: 'should be ignored',
    sessions: [{ id: 'ses_1' }]
  };
  const prefs = extractLightweightPrefs(state, 'proj_1');
  assert.equal(prefs.storageSchemaVersion, TARGET_SCHEMA_VERSION);
  assert.equal(prefs.model, 'gpt-5.4');
  assert.equal(prefs.reasoningEffort, 'high');
  assert.equal(prefs.speedTier, 'fast');
  assert.equal(prefs.mode, 'ask');
  assert.equal(prefs.locale, 'zh');
  assert.equal(prefs.requireReviewing, true);
  assert.equal(prefs.autoRecompile, true);
  assert.equal(prefs.loadCodexLocalSkills, false);
  assert.equal(prefs.loadCodexOverleafSkills, true);
  assert.equal(prefs.panelWidth, 512);
  assert.deepEqual(prefs.activeSessionByProject, { proj_1: 'ses_1' });
  assert.deepEqual(prefs.experimentalOtByProject, { proj_1: true, proj_2: false });
  assert.deepEqual(prefs.customInstructionsByProject, {
    proj_1: 'Use project terminology.',
    proj_2: 'Prefer concise edits.'
  });
  assert.deepEqual(prefs.governanceRulesByProject, {
    proj_1: {
      readonlyPatterns: ['locked/**'],
      writablePatterns: ['main.tex'],
      sensitiveCheckEnabled: false,
      sensitiveConfirmAllowed: true
    }
  });
  assert.deepEqual(prefs.selectedLocalSkillIdsByProject, {
    proj_1: ['style', 'citations']
  });
  assert.equal(prefs.extraField, undefined);
  assert.equal(prefs.sessions, undefined);
});

test('extractLightweightPrefs preserves only literal true experimental OT project prefs', () => {
  const prefs = extractLightweightPrefs({
    experimentalOtByProject: {
      proj_true: true,
      proj_false: false,
      proj_number: 1,
      proj_empty: '',
      proj_string: 'enabled',
      proj_object: {},
      proj_array: []
    }
  }, 'proj_true');

  assert.deepEqual(prefs.experimentalOtByProject, {
    proj_true: true,
    proj_false: false,
    proj_number: false,
    proj_empty: false,
    proj_string: false,
    proj_object: false,
    proj_array: false
  });
  assert.deepEqual(
    Object.values(prefs.experimentalOtByProject).map(value => typeof value),
    ['boolean', 'boolean', 'boolean', 'boolean', 'boolean', 'boolean', 'boolean']
  );
});

test('extractLightweightPrefs normalizes malformed custom instruction project prefs', () => {
  const longInstructions = 'x'.repeat(13000);
  const prefs = extractLightweightPrefs({
    customInstructionsByProject: {
      proj_text: 'Use project terminology.',
      proj_number: 1,
      proj_object: {},
      proj_array: [],
      proj_long: longInstructions,
      '': 'ignored'
    }
  }, 'proj_text');

  assert.equal(prefs.customInstructionsByProject.proj_text, 'Use project terminology.');
  assert.equal(prefs.customInstructionsByProject.proj_number, '');
  assert.equal(prefs.customInstructionsByProject.proj_object, '');
  assert.equal(prefs.customInstructionsByProject.proj_array, '');
  assert.equal(prefs.customInstructionsByProject.proj_long.length, 12000);
  assert.match(prefs.customInstructionsByProject.proj_long, /…$/);
  assert.equal(prefs.customInstructionsByProject[''], undefined);
  assert.deepEqual(
    Object.values(prefs.customInstructionsByProject).map(value => typeof value),
    ['string', 'string', 'string', 'string', 'string']
  );
});

test('extractLightweightPrefs defaults missing values', () => {
  const prefs = extractLightweightPrefs({}, 'proj_2');
  assert.equal(prefs.storageSchemaVersion, TARGET_SCHEMA_VERSION);
  assert.equal(prefs.model, '');
  assert.equal(prefs.reasoningEffort, '');
  assert.equal(prefs.speedTier, '');
  assert.equal(prefs.mode, 'ask');
  assert.equal(prefs.locale, '');
  assert.equal(prefs.requireReviewing, true);
  assert.equal(prefs.autoRecompile, true);
  assert.equal(prefs.loadCodexLocalSkills, true);
  assert.equal(prefs.loadCodexOverleafSkills, true);
  assert.equal(prefs.panelWidth, 0);
  assert.deepEqual(prefs.activeSessionByProject, {});
  assert.deepEqual(prefs.experimentalOtByProject, {});
  assert.deepEqual(prefs.customInstructionsByProject, {});
});

test('buildActiveSessionByProject merges new mapping into empty existing', () => {
  const result = buildActiveSessionByProject({}, 'proj_1', 'ses_1');
  assert.deepEqual(result, { proj_1: 'ses_1' });
});

test('buildActiveSessionByProject merges new mapping into existing', () => {
  const existing = { proj_1: 'ses_1', proj_2: 'ses_2' };
  const result = buildActiveSessionByProject(existing, 'proj_3', 'ses_3');
  assert.deepEqual(result, { proj_1: 'ses_1', proj_2: 'ses_2', proj_3: 'ses_3' });
});

test('buildActiveSessionByProject overwrites existing project mapping', () => {
  const existing = { proj_1: 'ses_old' };
  const result = buildActiveSessionByProject(existing, 'proj_1', 'ses_new');
  assert.deepEqual(result, { proj_1: 'ses_new' });
});

test('buildActiveSessionByProject handles null/undefined existing', () => {
  const result = buildActiveSessionByProject(null, 'proj_1', 'ses_1');
  assert.deepEqual(result, { proj_1: 'ses_1' });

  const result2 = buildActiveSessionByProject(undefined, 'proj_2', 'ses_2');
  assert.deepEqual(result2, { proj_2: 'ses_2' });
});

test('buildActiveSessionByProject skips empty projectId', () => {
  const existing = { proj_1: 'ses_1' };
  const result = buildActiveSessionByProject(existing, '', 'ses_new');
  assert.deepEqual(result, { proj_1: 'ses_1' });
});

// ---------------------------------------------------------------------------
// listRecentProjectsAcrossAccount (welcome-panel + write-guard v1.3.8 add-on,
// Task 3). The async wrapper opens IndexedDB and calls the pure helper
// `filterRecentProjectsAcrossAccount` — the tests exercise the helper directly
// so they do not need a fake IDB. The IDB wrapper is a thin shim: open + getAll
// + delegate; the contract (filter + dedupe + sort + cap + row shape) lives in
// the pure helper.
// ---------------------------------------------------------------------------
function seedSession(overrides) {
  return Object.assign({
    id: overrides.id || 'ses_seed',
    projectId: overrides.projectId || PROJECT_DEFAULT,
    accountScopeId: overrides.accountScopeId || null,
    lastActivityAt: overrides.lastActivityAt || '',
    safeTaskSummary: overrides.safeTaskSummary || '',
    runs: overrides.runs || []
  }, overrides);
}

const PROJECT_DEFAULT = 'd'.repeat(24);
const PROJECT_A = 'a'.repeat(24);
const PROJECT_B = 'b'.repeat(24);
const PROJECT_C = 'c'.repeat(24);

function projectIdForIndex(index) {
  return index.toString(16).padStart(24, '0');
}

test('listRecentProjectsAcrossAccount: filters by accountScopeId only', () => {
  const sessions = [
    seedSession({ id: 's1', projectId: PROJECT_A, accountScopeId: 'A', lastActivityAt: '2026-05-25T10:00:00Z' }),
    seedSession({ id: 's2', projectId: PROJECT_B, accountScopeId: 'B', lastActivityAt: '2026-05-25T11:00:00Z' }),
    seedSession({ id: 's3', projectId: PROJECT_C, accountScopeId: 'A', lastActivityAt: '2026-05-25T12:00:00Z' })
  ];
  const rows = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A' });
  assert.equal(rows.length, 2);
  const ids = rows.map(r => r.projectId).sort();
  assert.deepEqual(ids, [PROJECT_A, PROJECT_C]);
});

test('listRecentProjectsAcrossAccount: dedupes by projectId, keeping the largest lastActivityAt', () => {
  const sessions = [
    seedSession({ id: 's1', projectId: PROJECT_A, accountScopeId: 'A', lastActivityAt: '2026-05-20T09:00:00Z', safeTaskSummary: 'old' }),
    seedSession({ id: 's2', projectId: PROJECT_A, accountScopeId: 'A', lastActivityAt: '2026-05-25T15:00:00Z', safeTaskSummary: 'new' }),
    seedSession({ id: 's3', projectId: PROJECT_A, accountScopeId: 'A', lastActivityAt: '2026-05-22T11:00:00Z', safeTaskSummary: 'mid' })
  ];
  const rows = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, PROJECT_A);
  assert.equal(rows[0].lastActivityAt, '2026-05-25T15:00:00Z');
  assert.equal(rows[0].safeTaskSummary, 'new');
});

test('listRecentProjectsAcrossAccount: sorts desc by lastActivityAt', () => {
  const sessions = [
    seedSession({ id: 's1', projectId: PROJECT_A, accountScopeId: 'A', lastActivityAt: '2026-05-25T09:00:00Z' }),
    seedSession({ id: 's2', projectId: PROJECT_B, accountScopeId: 'A', lastActivityAt: '2026-05-25T13:00:00Z' }),
    seedSession({ id: 's3', projectId: PROJECT_C, accountScopeId: 'A', lastActivityAt: '2026-05-25T11:00:00Z' })
  ];
  const rows = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A' });
  assert.deepEqual(rows.map(r => r.projectId), [PROJECT_B, PROJECT_C, PROJECT_A]);
});

test('listRecentProjectsAcrossAccount: caps at the given limit', () => {
  const sessions = [];
  for (let i = 0; i < 15; i++) {
    sessions.push(seedSession({
      id: 's' + i,
      projectId: projectIdForIndex(i),
      accountScopeId: 'A',
      lastActivityAt: '2026-05-25T' + String(i).padStart(2, '0') + ':00:00Z'
    }));
  }
  const rowsDefault = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A' });
  assert.equal(rowsDefault.length, 10, 'default limit is 10');
  const rowsCustom = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A', limit: 3 });
  assert.equal(rowsCustom.length, 3);
});

test('listRecentProjectsAcrossAccount: returns [] when accountScopeId is falsy (fail-closed)', () => {
  const sessions = [
    seedSession({ id: 's1', projectId: PROJECT_A, accountScopeId: 'A', lastActivityAt: '2026-05-25T09:00:00Z' })
  ];
  assert.deepEqual(filterRecentProjectsAcrossAccount(sessions, { accountScopeId: null }), []);
  assert.deepEqual(filterRecentProjectsAcrossAccount(sessions, { accountScopeId: '' }), []);
  assert.deepEqual(filterRecentProjectsAcrossAccount(sessions, {}), []);
});

test('listRecentProjectsAcrossAccount: excludes legacy records lacking accountScopeId or lastActivityAt', () => {
  const sessions = [
    seedSession({ id: 's1', projectId: PROJECT_A, accountScopeId: 'A', lastActivityAt: '2026-05-25T09:00:00Z' }),
    seedSession({ id: 's2', projectId: PROJECT_B, accountScopeId: null, lastActivityAt: '2026-05-25T10:00:00Z' }),
    seedSession({ id: 's3', projectId: PROJECT_C, accountScopeId: 'A', lastActivityAt: '' }),
    // legacy record: no fields at all
    { id: 's4', projectId: projectIdForIndex(4), runs: [] }
  ];
  const rows = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, PROJECT_A);
});

test('listRecentProjectsAcrossAccount: excludes records lacking an openable projectId', () => {
  const sessions = [
    seedSession({ id: 's1', projectId: '', accountScopeId: 'A', lastActivityAt: '2026-05-25T09:00:00Z' }),
    seedSession({ id: 's2', projectId: 'https://www.overleaf.com/project', accountScopeId: 'A', lastActivityAt: '2026-05-25T10:00:00Z' }),
    seedSession({ id: 's3', projectId: 'p2', accountScopeId: 'A', lastActivityAt: '2026-05-25T11:00:00Z' }),
    seedSession({ id: 's4', projectId: PROJECT_B, accountScopeId: 'A', lastActivityAt: '2026-05-25T12:00:00Z' })
  ];
  const rows = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, PROJECT_B);
});

test('listRecentProjectsAcrossAccount: row contract has the five fields (v1.8.1 adds sessionCount) and does not expose latestSessionId', () => {
  const sessions = [
    seedSession({
      id: 's_internal_id',
      projectId: PROJECT_A,
      accountScopeId: 'A',
      lastActivityAt: '2026-05-25T09:00:00Z',
      safeTaskSummary: 'rewrite section',
      runs: [{ id: 'r1', status: 'completed' }]
    })
  ];
  const rows = filterRecentProjectsAcrossAccount(sessions, { accountScopeId: 'A' });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['lastActivityAt', 'primaryStatusBadge', 'projectId', 'safeTaskSummary', 'sessionCount']);
  assert.equal(row.sessionCount, 1);
  assert.equal(row.projectId, PROJECT_A);
  assert.equal(row.lastActivityAt, '2026-05-25T09:00:00Z');
  assert.equal(row.safeTaskSummary, 'rewrite section');
  assert.equal(row.primaryStatusBadge, 'completed');
  // latestSessionId is internal (see spec §5.6.1) and must NOT leak into the row contract.
  assert.ok(!('latestSessionId' in row), 'latestSessionId must not be exposed in v1 row contract');
  assert.ok(!('id' in row), 'internal session id must not be exposed');
});

test('listRecentProjectsAcrossAccount: empty source returns []', () => {
  assert.deepEqual(filterRecentProjectsAcrossAccount([], { accountScopeId: 'A' }), []);
  assert.deepEqual(filterRecentProjectsAcrossAccount(null, { accountScopeId: 'A' }), []);
  assert.deepEqual(filterRecentProjectsAcrossAccount(undefined, { accountScopeId: 'A' }), []);
});

// ---------------------------------------------------------------------------
// derivePrimaryStatusBadge (spec §5.10): prefer the latest run's
// trackedChangeStatus → fall back to runStatus → fall back to 'pending'.
// ---------------------------------------------------------------------------
test('derivePrimaryStatusBadge prefers trackedChangeStatus on the latest run', () => {
  const session = {
    runs: [
      { id: 'r1', status: 'completed', trackedChangeStatus: 'rejected' },
      { id: 'r2', status: 'completed', trackedChangeStatus: 'pending' }
    ]
  };
  assert.equal(derivePrimaryStatusBadge(session), 'pending');
});

test('derivePrimaryStatusBadge falls back to runStatus when trackedChangeStatus is absent', () => {
  const session = {
    runs: [
      { id: 'r1', status: 'completed' },
      { id: 'r2', status: 'background_completed' }
    ]
  };
  assert.equal(derivePrimaryStatusBadge(session), 'background_completed');
});

test('derivePrimaryStatusBadge surfaces post-navigation runStatus values', () => {
  assert.equal(derivePrimaryStatusBadge({ runs: [{ id: 'r', status: 'needs_review_after_navigation' }] }),
    'needs_review_after_navigation');
  assert.equal(derivePrimaryStatusBadge({ runs: [{ id: 'r', status: 'abandoned_after_navigation' }] }),
    'abandoned_after_navigation');
});

test('derivePrimaryStatusBadge falls back to pending when no runs present', () => {
  assert.equal(derivePrimaryStatusBadge({}), 'pending');
  assert.equal(derivePrimaryStatusBadge({ runs: [] }), 'pending');
  assert.equal(derivePrimaryStatusBadge({ runs: [{}] }), 'pending');
});

// ---------------------------------------------------------------------------
// runStatus storage round-trip (welcome-panel + write-guard v1.3.8 add-on,
// Task 3 verification): a session record carrying one of the three new
// post-navigation `runStatus` values must survive `buildSessionRecord` /
// `compactRunForStorage` round-trip — the storage-side normalizer must NOT
// downgrade them to `completed`.
// ---------------------------------------------------------------------------
test('storage round-trip preserves background_completed runStatus', () => {
  const record = buildSessionRecord({
    id: 'ses_bg',
    projectId: 'p1',
    runs: [{ id: 'r1', task: 'background run', status: 'background_completed' }]
  });
  assert.equal(record.runs[0].status, 'background_completed');
});

test('storage round-trip preserves needs_review_after_navigation runStatus', () => {
  const record = buildSessionRecord({
    id: 'ses_nra',
    projectId: 'p2',
    runs: [{ id: 'r1', task: 'review', status: 'needs_review_after_navigation' }]
  });
  assert.equal(record.runs[0].status, 'needs_review_after_navigation');
});

test('storage round-trip preserves abandoned_after_navigation runStatus', () => {
  const record = buildSessionRecord({
    id: 'ses_aan',
    projectId: 'p3',
    runs: [{ id: 'r1', task: 'abandoned', status: 'abandoned_after_navigation' }]
  });
  assert.equal(record.runs[0].status, 'abandoned_after_navigation');
});

// ---------------------------------------------------------------------------
// buildSessionRecord: the four new Recent-projects fields (Task 3).
// ---------------------------------------------------------------------------
test('buildSessionRecord populates lastActivityAt from updatedAt when no explicit value', () => {
  const record = buildSessionRecord({
    id: 'ses_la',
    projectId: 'p1',
    updatedAt: '2026-05-25T15:00:00.000Z'
  });
  assert.equal(record.lastActivityAt, '2026-05-25T15:00:00.000Z');
});

test('buildSessionRecord preserves explicit lastActivityAt from input', () => {
  const record = buildSessionRecord({
    id: 'ses_la2',
    projectId: 'p1',
    updatedAt: '2026-05-25T15:00:00.000Z',
    lastActivityAt: '2026-05-25T16:30:00.000Z'
  });
  assert.equal(record.lastActivityAt, '2026-05-25T16:30:00.000Z');
});

test('buildSessionRecord uses input.accountScopeId when provided', () => {
  const record = buildSessionRecord({
    id: 'ses_scope',
    projectId: 'p1',
    accountScopeId: 'acct_explicit'
  });
  assert.equal(record.accountScopeId, 'acct_explicit');
  assert.equal(record.accountScopeUnavailable, false);
});

test('buildSessionRecord computes safeTaskSummary from the task text when none provided', () => {
  const record = buildSessionRecord({
    id: 'ses_sum',
    projectId: 'p1',
    task: 'rewrite intro per /Users/alice/notes.md'
  });
  assert.ok(!record.safeTaskSummary.includes('/Users/alice'));
  assert.ok(record.safeTaskSummary.includes('<local-path>'));
});

test('buildSessionRecord preserves explicit safeTaskSummary from input', () => {
  const record = buildSessionRecord({
    id: 'ses_sum2',
    projectId: 'p1',
    task: 'whatever',
    safeTaskSummary: 'precomputed value'
  });
  assert.equal(record.safeTaskSummary, 'precomputed value');
});

test('buildSessionRecord sets accountScopeUnavailable=true and accountScopeId=null with no injection', () => {
  const prior = global.window;
  global.window = {}; // no derive fn
  try {
    const record = buildSessionRecord({ id: 'ses_no_inject', projectId: 'p1' });
    assert.equal(record.accountScopeId, null);
    assert.equal(record.accountScopeUnavailable, true);
  } finally {
    global.window = prior;
  }
});

test('buildSessionRecord preserves a report event detailStructured + failure across persistence', () => {
  // Regression: the run-event compaction whitelisted fields and dropped
  // detailStructured + failure, so a completion report re-rendered from a
  // persisted record fell back to the FLAT legacy render (Write result / Undo
  // / Next no longer demoted into the muted meta block) and the recovery
  // action button vanished. Both must survive buildSessionRecord with their
  // object shape intact.
  const record = buildSessionRecord({
    id: 'ses_struct',
    projectId: 'proj_struct',
    runs: [{
      id: 'run_struct',
      task: 'edit intro',
      status: 'completed',
      startedAt: '2026-05-27T00:00:00.000Z',
      finishedAt: '2026-05-27T00:00:18.000Z',
      events: [{
        title: 'Task report',
        status: 'completed',
        kind: 'report',
        detail: 'Conclusion: synced. \n\nWrite result: wrote 1 item, skipped 0 items',
        detailStructured: {
          conclusion: 'Local Codex changes were synced back to Overleaf.',
          body: 'Changes:\n- main.tex: edit',
          meta: [
            { key: 'writeResult', label: 'Write result', value: 'wrote 1 item, skipped 0 items' },
            { key: 'undo', label: 'Undo', value: 'this run has 1 reversible write' },
            { key: 'nextStep', label: 'Next', value: 'Review the synced file in Overleaf.' }
          ]
        },
        failure: {
          code: 'codex_project_locked',
          stage: 'codex',
          severity: 'blocked',
          userMessage: 'Another Codex task is already running for this project.',
          nextAction: 'Wait or cancel before retrying.',
          retryable: true,
          terminalState: 'blocked',
          changedDocument: false
        }
      }]
    }]
  });

  const event = record.runs[0].events[0];
  // detailStructured survives with its shape (conclusion/body/meta array).
  assert.ok(event.detailStructured, 'detailStructured must survive persistence');
  assert.equal(event.detailStructured.conclusion, 'Local Codex changes were synced back to Overleaf.');
  assert.match(event.detailStructured.body, /main\.tex: edit/);
  assert.ok(Array.isArray(event.detailStructured.meta), 'meta must stay an array');
  assert.equal(event.detailStructured.meta.length, 3);
  assert.equal(event.detailStructured.meta[0].key, 'writeResult');
  assert.equal(event.detailStructured.meta[0].label, 'Write result');
  assert.match(event.detailStructured.meta[0].value, /wrote 1 item/);
  // failure survives with code (drives the recovery action + run-card status).
  assert.ok(event.failure, 'failure must survive persistence');
  assert.equal(event.failure.code, 'codex_project_locked');
  assert.equal(event.failure.terminalState, 'blocked');
});

test('buildSessionRecord preserves canonical run settlement projections across reload', () => {
  const SettlementFacts = require('../extension/src/shared/settlementFacts');
  const record = buildSessionRecord({
    id: 'ses_settlement',
    projectId: 'proj_settlement',
    runs: [{
      id: 'run_settlement',
      task: 'edit intro',
      status: 'completed',
      trackedChangeStatus: 'needs_review',
      settlement: {
        documentEffect: 'changed',
        evidence: {
          applied: 'complete',
          readBack: 'exact',
          saved: 'verified',
          settled: 'needs-review'
        },
        failures: [{
          code: 'accept_not_verified',
          stage: 'accept',
          severity: 'warning',
          userMessage: 'The tracked changes could not be verified as clean.',
          retryable: true,
          nextAction: 'Review and retry Accept.',
          changedDocument: true,
          terminalState: 'needs_review'
        }]
      }
    }]
  });

  const run = record.runs[0];
  const projection = SettlementFacts.projectRunSettlement(run);
  assert.ok(run.settlement, 'canonical settlement must survive StorageDb compaction');
  assert.equal(run.settlementFacts, undefined);
  assert.equal(projection.changedDocument, true);
  assert.equal(projection.terminalState, 'needs_review');
  assert.equal(projection.canRetry, true);
  assert.equal(projection.primaryFailure.code, 'accept_not_verified');
});

test('buildSessionRecord redacts secrets and absolute local paths inside canonical settlement', () => {
  const record = buildSessionRecord({
    id: 'ses_private_settlement',
    projectId: 'proj_private_settlement',
    runs: [{
      id: 'run_private_settlement',
      settlement: {
        failures: [{
          code: 'write_failed',
          stage: 'write',
          severity: 'error',
          userMessage: 'Token sk-proj-12345678901234567890 failed in /Users/alice/private/main.tex',
          nextAction: 'Inspect /Users/alice/private/main.tex',
          retryable: true
        }]
      }
    }]
  });
  const serialized = JSON.stringify(record.runs[0].settlement);

  assert.doesNotMatch(serialized, /sk-proj-12345678901234567890/);
  assert.doesNotMatch(serialized, /\/Users\/alice\/private/);
  assert.equal(record.runs[0].settlement.failures[0].code, 'write_failed');
});
