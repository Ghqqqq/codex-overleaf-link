const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_PANEL_STATE,
  createSession,
  deleteSession,
  getActiveSession,
  isDisplayableSession,
  normalizePanelState,
  normalizeRuns,
  prepareStateForStorage,
  estimateJsonBytes,
  recordSessionResult,
  selectVisibleSessionsForList,
  setActiveSession,
  updateActiveSession,
  computeSafeTaskSummary
} = require('../extension/src/shared/sessionState');

const SECRET = ['sk', 'v0test_DO_NOT_LEAK_1234567890abcdef'].join('-');
const SECRET_PATH = `sections/${SECRET}/main.tex`;
const PROJECT_TEXT = `PROJECT_TEXT_SHOULD_NOT_PERSIST ${SECRET}`;
const TASK_PROMPT = `TASK_PROMPT_SHOULD_NOT_PERSIST ${SECRET}`;
const COMPILE_LOG = `COMPILE_LOG_SHOULD_NOT_PERSIST ${SECRET}`;
const COMMAND_OUTPUT = `COMMAND_OUTPUT_SHOULD_NOT_PERSIST ${SECRET}`;
const NO_SECRET_PROMPT_BODY = 'PROMPT_BODY_SHOULD_NOT_PERSIST';
const NO_SECRET_COMMAND_OUTPUT = 'COMMAND_OUTPUT_SHOULD_NOT_PERSIST';
const NO_SECRET_COMPILE_LOG = 'COMPILE_LOG_SHOULD_NOT_PERSIST';
const NO_SECRET_RAW_DIFF = 'RAW_DIFF_SHOULD_NOT_PERSIST';
const NO_SECRET_PROJECT_TEXT = 'PROJECT_TEXT_SHOULD_NOT_PERSIST';
const NO_SECRET_IMAGE_DATA_URL = 'data:image/png;base64,NO_SECRET_IMAGE_DATA_SHOULD_NOT_PERSIST';
const GITHUB_PAT = ['ghp', 'A'.repeat(36)].join('_');
const GITHUB_FINE_GRAINED_PAT = ['github', 'pat', 'B'.repeat(36)].join('_');
const SLACK_TOKEN = `xoxb-${'C'.repeat(24)}`;
const AWS_ACCESS_KEY = `AKIA${'D'.repeat(16)}`;
const BEARER_TOKEN_VALUE = `${'e'.repeat(32)}.${'f'.repeat(16)}`;
const BEARER_TOKEN = `Bearer ${BEARER_TOKEN_VALUE}`;
const PRIVATE_KEY_BLOCK = [
  '-----BEGIN ' + 'PRIVATE KEY-----',
  'MIIEvCOMMONSECRETKEYDATA',
  '-----END ' + 'PRIVATE KEY-----'
].join('\n');
const API_KEY_VALUE = 'api_key_common_secret_12345';
const TOKEN_VALUE = 'token_common_secret_12345';
const PASSWORD_VALUE = 'password_common_secret_12345';
const COMMON_SECRET_TEXT = [
  GITHUB_PAT,
  GITHUB_FINE_GRAINED_PAT,
  SLACK_TOKEN,
  AWS_ACCESS_KEY,
  BEARER_TOKEN,
  PRIVATE_KEY_BLOCK,
  `api_key=${API_KEY_VALUE}`,
  `token: ${TOKEN_VALUE}`,
  `password=${PASSWORD_VALUE}`
].join(' ');
const COMMON_SECRET_FORBIDDEN_VALUES = [
  GITHUB_PAT,
  GITHUB_FINE_GRAINED_PAT,
  SLACK_TOKEN,
  AWS_ACCESS_KEY,
  BEARER_TOKEN_VALUE,
  'MIIEvCOMMONSECRETKEYDATA',
  API_KEY_VALUE,
  TOKEN_VALUE,
  PASSWORD_VALUE
];
const RAW_LOCAL_PATH = '/Users/alice/.codex-overleaf/projects/project-a/workspace/main.tex:117';
const RAW_LOCAL_PATH_COLUMN = '/Users/alice/.codex-overleaf/projects/project-a/workspace/main.tex:117:9';
const RAW_LOCAL_DIR = '/Users/alice/.codex-overleaf/projects/project-a/workspace/sections';

function assertNoRawLocalPaths(value, label = 'value') {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    '/Users/alice',
    '.codex-overleaf/projects/project-a',
    RAW_LOCAL_PATH,
    RAW_LOCAL_PATH_COLUMN,
    RAW_LOCAL_DIR
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${label} leaked ${forbidden}`);
  }
}

test('normalizes missing panel state with defaults and a session id', () => {
  const state = normalizePanelState({});

  assert.equal(state.mode, DEFAULT_PANEL_STATE.mode);
  assert.equal(state.model, DEFAULT_PANEL_STATE.model);
  assert.equal(state.reasoningEffort, DEFAULT_PANEL_STATE.reasoningEffort);
  assert.equal(state.speedTier, DEFAULT_PANEL_STATE.speedTier);
  assert.equal(state.locale, 'en');
  assert.equal(state.loadCodexLocalSkills, true);
  assert.equal(state.loadCodexOverleafSkills, true);
  assert.equal(state.preloadProjectContext, true);
  assert.deepEqual(state.customInstructionsByProject, {});
  assert.match(state.session.id, /^session_/);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.activeSessionId, state.session.id);
});

test('normalizes Codex skill loading toggles as global panel preferences', () => {
  const state = normalizePanelState({
    preloadProjectContext: false,
    loadCodexLocalSkills: false,
    loadCodexOverleafSkills: false,
    activeSessionId: 'session_a',
    sessions: [
      { id: 'session_a', title: 'A', runs: [] },
      { id: 'session_b', title: 'B', runs: [] }
    ]
  });

  assert.equal(state.preloadProjectContext, false);
  assert.equal(state.loadCodexLocalSkills, false);
  assert.equal(state.loadCodexOverleafSkills, false);

  const switched = setActiveSession(state, 'session_b');
  assert.equal(switched.loadCodexLocalSkills, false);
  assert.equal(switched.loadCodexOverleafSkills, false);

  const compact = prepareStateForStorage(switched);
  assert.equal(compact.preloadProjectContext, false);
  assert.equal(compact.loadCodexLocalSkills, false);
  assert.equal(compact.loadCodexOverleafSkills, false);
});

test('normalizes locale as a global panel preference across sessions', () => {
  const state = normalizePanelState({
    locale: 'zh',
    activeSessionId: 'session_a',
    sessions: [
      { id: 'session_a', title: 'A', runs: [] },
      { id: 'session_b', title: 'B', runs: [] }
    ]
  });

  assert.equal(state.locale, 'zh');

  const switched = setActiveSession(state, 'session_b');
  assert.equal(switched.locale, 'zh');

  const compact = prepareStateForStorage(switched);
  assert.equal(compact.locale, 'zh');
});

test('normalizes custom instructions as a project-level preference across sessions', () => {
  const state = normalizePanelState({
    customInstructionsByProject: {
      project_a: 'Use NeurIPS style. Prefer \\cref{}.',
      project_b: 42,
      '': 'ignored'
    },
    activeSessionId: 'session_a',
    sessions: [
      { id: 'session_a', title: 'A', runs: [] },
      { id: 'session_b', title: 'B', runs: [] }
    ]
  });

  assert.deepEqual(state.customInstructionsByProject, {
    project_a: 'Use NeurIPS style. Prefer \\cref{}.',
    project_b: ''
  });

  const switched = setActiveSession(state, 'session_b');
  assert.deepEqual(switched.customInstructionsByProject, state.customInstructionsByProject);

  const compact = prepareStateForStorage(switched);
  assert.deepEqual(compact.customInstructionsByProject, state.customInstructionsByProject);
});

test('length-limits custom instruction values during normalization and storage compaction', () => {
  const longInstructions = 'x'.repeat(13000);
  const state = normalizePanelState({
    customInstructionsByProject: {
      project_long: longInstructions
    }
  });

  assert.equal(state.customInstructionsByProject.project_long.length, 12000);
  assert.match(state.customInstructionsByProject.project_long, /…$/);

  const compact = prepareStateForStorage({
    ...state,
    customInstructionsByProject: {
      project_long: longInstructions
    }
  });
  assert.equal(compact.customInstructionsByProject.project_long.length, 12000);
  assert.match(compact.customInstructionsByProject.project_long, /…$/);
});

test('creates a fresh session with empty history', () => {
  const session = createSession();

  assert.match(session.id, /^session_/);
  assert.deepEqual(session.history, []);
  assert.deepEqual(session.runs, []);
  assert.deepEqual(session.focusFiles, []);
  assert.equal(session.title, '');
  assert.equal(session.titleSource, 'auto');
});

test('derives compact auto titles from the first task without context tokens', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_a',
    sessions: [{
      id: 'session_a',
      title: '',
      titleSource: 'auto',
      task: '',
      runs: []
    }]
  });

  const updated = updateActiveSession(state, {
    title: '帮我检查一下语法问题并直接修复这篇论文中的明显错误 @context @file:paper.tex',
    titleSource: 'auto'
  });

  assert.equal(updated.sessions[0].title, '帮我检查一下语法问题并直接修复这篇论文中的明显…');
  assert.equal(updated.sessions[0].titleSource, 'auto');
});

test('manual session titles survive later task updates', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_a',
    sessions: [{
      id: 'session_a',
      title: 'AAAI 摘要润色',
      titleSource: 'manual',
      task: 'old draft',
      runs: []
    }]
  });

  const updated = updateActiveSession(state, {
    task: '帮我检查语法问题并修正',
    title: '帮我检查语法问题并修正',
    titleSource: 'auto'
  });

  assert.equal(updated.sessions[0].title, 'AAAI 摘要润色');
  assert.equal(updated.sessions[0].titleSource, 'manual');
});

test('normalizes focus files as session scoped context', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_a',
    sessions: [{
      id: 'session_a',
      title: 'A',
      focusFiles: ['main.tex', '', 'main.tex', 42, 'refs.bib']
    }]
  });

  assert.deepEqual(state.session.focusFiles, ['main.tex', 'refs.bib']);
  assert.deepEqual(state.sessions[0].focusFiles, ['main.tex', 'refs.bib']);

  const updated = updateActiveSession(state, { task: 'Check intro' });
  assert.deepEqual(updated.session.focusFiles, ['main.tex', 'refs.bib']);
  assert.deepEqual(updated.sessions[0].focusFiles, ['main.tex', 'refs.bib']);
});

test('does not display a blank default session as a task', () => {
  assert.equal(isDisplayableSession(createSession()), false);
  assert.equal(isDisplayableSession({
    id: 'session_draft',
    title: 'New task',
    task: 'draft prompt',
    runs: [],
    history: []
  }), true);
  assert.equal(isDisplayableSession({
    id: 'session_run',
    title: 'New task',
    task: '',
    runs: [{ id: 'run_1', task: 'done', status: 'completed' }],
    history: []
  }), true);
});

test('session list keeps an older active session visible alongside recent sessions', () => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    id: `session_${index}`,
    title: `Task ${index}`,
    runs: [{ id: `run_${index}`, task: `task ${index}`, status: 'completed' }],
    history: []
  }));

  const visible = selectVisibleSessionsForList(sessions, 'session_0', { maxVisible: 3 });

  assert.deepEqual(visible.map(session => session.id), ['session_0', 'session_4', 'session_3']);
});

test('session list keeps a running pinned session visible alongside the active session', () => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    id: `session_${index}`,
    title: `Task ${index}`,
    runs: [{ id: `run_${index}`, task: `task ${index}`, status: 'completed' }],
    history: []
  }));

  const visible = selectVisibleSessionsForList(sessions, 'session_0', {
    maxVisible: 3,
    pinnedSessionIds: ['session_1']
  });

  assert.deepEqual(visible.map(session => session.id), ['session_0', 'session_1', 'session_4']);
});

test('records bounded session history', () => {
  let session = createSession();
  for (let index = 0; index < 12; index += 1) {
    session = recordSessionResult(session, {
      task: `task ${index}`,
      result: `result ${index}`
    });
  }

  assert.equal(session.history.length, 10);
  assert.equal(session.history[0].task, 'task 2');
  assert.equal(session.history[9].task, 'task 11');
});

test('recordSessionResult preserves existing session runs and settings', () => {
  const session = createSession({
    title: 'Grammar pass',
    task: '帮我检查语法',
    mode: 'auto',
    model: 'gpt-5.4-mini',
    reasoningEffort: 'xhigh',
    requireReviewing: false,
    focusFiles: ['paper.tex'],
    codexThreadId: 'thread_123',
    runs: [{
      id: 'run_1',
      task: '帮我检查语法',
      status: 'completed',
      events: [{ title: '本轮完成报告', status: 'completed' }]
    }]
  });

  const updated = recordSessionResult(session, {
    task: '帮我检查语法',
    result: '已检查并总结'
  });

  assert.equal(updated.id, session.id);
  assert.equal(updated.title, 'Grammar pass');
  assert.equal(updated.task, '帮我检查语法');
  assert.equal(updated.mode, 'auto');
  assert.equal(updated.model, 'gpt-5.4-mini');
  assert.equal(updated.reasoningEffort, 'xhigh');
  assert.equal(updated.requireReviewing, false);
  assert.deepEqual(updated.focusFiles, ['paper.tex']);
  assert.equal(updated.codexThreadId, 'thread_123');
  assert.equal(updated.runs[0].id, 'run_1');
  assert.equal(updated.history.at(-1).result, '已检查并总结');
});

test('recordSessionResult redacts local absolute paths from stored history text', () => {
  const session = createSession({
    title: 'Local path redaction',
    task: `Inspect ${RAW_LOCAL_PATH}`
  });

  const updated = recordSessionResult(session, {
    task: `Please inspect ${RAW_LOCAL_PATH}`,
    result: [
      'Final answer:',
      RAW_LOCAL_PATH,
      `Inline code \`${RAW_LOCAL_PATH_COLUMN}\``,
      '```',
      RAW_LOCAL_DIR,
      '```'
    ].join('\n'),
    status: `failed while opening ${RAW_LOCAL_PATH}`
  });

  assertNoRawLocalPaths(updated.history, 'recordSessionResult history');
  assert.match(updated.history.at(-1).result, /local path|main\.tex/);
});

test('normalizes run attachment previews in memory and omits raw previews from compact storage', () => {
  const state = normalizePanelState({
    runs: [{
      id: 'run_attachments',
      task: '解读下图片',
      status: 'completed',
      attachments: [
        {
          name: 'image.png',
          mimeType: 'image/png',
          size: 1234,
          kind: 'image',
          previewDataUrl: 'data:image/png;base64,abc123',
          contentBase64: 'raw-file-content-must-not-persist'
        },
        {
          name: '../CV_CN.pdf',
          mimeType: 'application/pdf',
          size: 4567,
          kind: 'file',
          previewDataUrl: 'data:application/pdf;base64,drop'
        }
      ]
    }]
  });

  assert.deepEqual(state.runs[0].attachments, [
    {
      name: 'image.png',
      mimeType: 'image/png',
      size: 1234,
      kind: 'image',
      previewDataUrl: 'data:image/png;base64,abc123'
    },
    {
      name: 'CV_CN.pdf',
      mimeType: 'application/pdf',
      size: 4567,
      kind: 'file',
      previewDataUrl: ''
    }
  ]);

  const compact = prepareStateForStorage(state);
  assert.deepEqual(compact.sessions[0].runs[0].attachments, [
    {
      name: 'image.png',
      mimeType: 'image/png',
      size: 1234,
      kind: 'image'
    },
    {
      name: 'CV_CN.pdf',
      mimeType: 'application/pdf',
      size: 4567,
      kind: 'file'
    }
  ]);
  assert.equal(JSON.stringify(compact).includes('data:image/png;base64,abc123'), false);
  assert.equal(JSON.stringify(compact).includes('raw-file-content-must-not-persist'), false);
});

test('prepareStateForStorage redacts seeded secrets from persisted session state', () => {
  const state = normalizePanelState({
    task: TASK_PROMPT,
    focusFiles: [SECRET_PATH],
    customInstructionsByProject: {
      [`project-${SECRET}`]: `Prefer concise edits ${SECRET}`
    },
    sessions: [{
      id: 'session_secret',
      title: `Secret session ${SECRET}`,
      task: TASK_PROMPT,
      history: [{
        task: TASK_PROMPT,
        result: COMMAND_OUTPUT,
        at: '2026-05-06T00:00:00.000Z'
      }],
      focusFiles: [SECRET_PATH],
      runs: [{
        id: 'run_secret',
        task: TASK_PROMPT,
        status: 'completed',
        statusText: COMMAND_OUTPUT,
        events: [{
          title: `Compile failed ${SECRET}`,
          status: 'failed',
          kind: 'report',
          detail: {
            commandOutput: COMMAND_OUTPUT,
            compileLog: COMPILE_LOG,
            projectText: PROJECT_TEXT,
            path: SECRET_PATH
          },
          technicalDetail: {
            raw: COMMAND_OUTPUT
          }
        }],
        attachments: [{
          name: SECRET_PATH,
          mimeType: 'text/plain',
          size: 128,
          previewDataUrl: ''
        }],
        undoOperations: [{
          type: 'edit',
          path: SECRET_PATH,
          replaceAll: PROJECT_TEXT
        }],
        undoBaseFiles: [{ path: SECRET_PATH, content: PROJECT_TEXT }],
        undoExpectedFiles: [{ path: SECRET_PATH, content: PROJECT_TEXT }],
        undoTrackedChanges: [{ key: `tracked-${SECRET}`, path: SECRET_PATH, label: `Change ${SECRET}` }]
      }]
    }],
    activeSessionId: 'session_secret'
  });

  const compact = prepareStateForStorage(state);
  const serialized = JSON.stringify(compact);

  for (const forbidden of [
    SECRET,
    PROJECT_TEXT,
    TASK_PROMPT,
    COMPILE_LOG,
    COMMAND_OUTPUT,
    SECRET_PATH
  ]) {
    assert.equal(serialized.includes(forbidden), false, `persisted state leaked ${forbidden}`);
  }

  const run = compact.sessions[0].runs[0];
  assert.equal(run.undoOperations.length, 0);
  assert.equal(run.undoBaseFiles.length, 0);
  assert.equal(run.undoExpectedFiles.length, 0);
});

test('prepareStateForStorage redacts common secret formats from persisted session state', () => {
  const state = normalizePanelState({
    task: `Rotate leaked credentials ${COMMON_SECRET_TEXT}`,
    focusFiles: [`sections/${GITHUB_PAT}/main.tex`],
    customInstructionsByProject: {
      [`project-${GITHUB_FINE_GRAINED_PAT}`]: `Use replacement token: ${TOKEN_VALUE}`
    },
    sessions: [{
      id: 'session_common_secrets',
      title: `Secret rotation ${GITHUB_PAT}`,
      task: `Rotate leaked credentials ${COMMON_SECRET_TEXT}`,
      history: [{
        task: `History ${GITHUB_PAT}`,
        result: COMMON_SECRET_TEXT,
        at: '2026-05-06T00:00:00.000Z'
      }],
      focusFiles: [`sections/${SLACK_TOKEN}/main.tex`],
      runs: [{
        id: 'run_common_secrets',
        task: `Run ${COMMON_SECRET_TEXT}`,
        status: 'completed',
        statusText: `Failed with ${BEARER_TOKEN}`,
        events: [{
          title: `Event ${GITHUB_PAT}`,
          status: 'failed',
          kind: 'report',
          detail: {
            summary: COMMON_SECRET_TEXT,
            path: `sections/${AWS_ACCESS_KEY}/main.tex`
          },
          technicalDetail: {
            raw: COMMON_SECRET_TEXT
          }
        }],
        attachments: [{
          name: `attachment-${SLACK_TOKEN}.txt`,
          mimeType: 'text/plain',
          size: 128,
          previewDataUrl: ''
        }],
        undoOperations: [{
          type: 'edit',
          path: `sections/${GITHUB_PAT}/main.tex`,
          replaceAll: COMMON_SECRET_TEXT
        }],
        undoBaseFiles: [{ path: `sections/${GITHUB_PAT}/main.tex`, content: COMMON_SECRET_TEXT }],
        undoExpectedFiles: [{ path: `sections/${GITHUB_PAT}/main.tex`, content: COMMON_SECRET_TEXT }],
        undoTrackedChanges: [{ key: `tracked-${GITHUB_PAT}`, path: `sections/${SLACK_TOKEN}/main.tex`, label: `Change ${AWS_ACCESS_KEY}` }],
        undoStatus: `undo ${BEARER_TOKEN}`
      }]
    }],
    activeSessionId: 'session_common_secrets'
  });

  const compact = prepareStateForStorage(state);
  const serialized = JSON.stringify(compact);
  assert.match(compact.task, /^\[task omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
  for (const forbidden of COMMON_SECRET_FORBIDDEN_VALUES) {
    assert.equal(serialized.includes(forbidden), false, `persisted state leaked ${forbidden}`);
  }

  const run = compact.sessions[0].runs[0];
  assert.equal(run.undoOperations.length, 0);
  assert.equal(run.undoBaseFiles.length, 0);
  assert.equal(run.undoExpectedFiles.length, 0);
});

test('prepareStateForStorage summarizes no-secret prompt and body fields instead of persisting raw text', () => {
  const state = normalizePanelState({
    task: NO_SECRET_PROMPT_BODY,
    sessions: [{
      id: 'session_no_secret_privacy',
      title: 'No-secret privacy regression',
      task: NO_SECRET_PROMPT_BODY,
      history: [{
        task: NO_SECRET_PROMPT_BODY,
        result: NO_SECRET_COMMAND_OUTPUT,
        at: '2026-05-06T00:00:00.000Z'
      }],
      focusFiles: ['main.tex', 'sections/method.tex'],
      runs: [{
        id: 'run_no_secret_privacy',
        task: NO_SECRET_PROMPT_BODY,
        status: 'failed',
        statusText: NO_SECRET_COMMAND_OUTPUT,
        startedAt: '2026-05-06T00:00:00.000Z',
        finishedAt: '2026-05-06T00:01:00.000Z',
        events: [{
          title: NO_SECRET_COMMAND_OUTPUT,
          status: NO_SECRET_COMMAND_OUTPUT,
          kind: 'report',
          detail: {
            commandOutput: NO_SECRET_COMMAND_OUTPUT,
            compileLog: NO_SECRET_COMPILE_LOG,
            rawDiff: NO_SECRET_RAW_DIFF,
            projectText: NO_SECRET_PROJECT_TEXT,
            path: 'main.tex'
          }
        }],
        attachments: [{
          name: 'figure.png',
          mimeType: 'image/png',
          size: 256,
          kind: 'image',
          previewDataUrl: NO_SECRET_IMAGE_DATA_URL
        }]
      }]
    }],
    activeSessionId: 'session_no_secret_privacy'
  });

  const compact = prepareStateForStorage(state);
  const serialized = JSON.stringify(compact);

  for (const forbidden of [
    NO_SECRET_PROMPT_BODY,
    NO_SECRET_COMMAND_OUTPUT,
    NO_SECRET_COMPILE_LOG,
    NO_SECRET_RAW_DIFF,
    NO_SECRET_PROJECT_TEXT,
    NO_SECRET_IMAGE_DATA_URL
  ]) {
    assert.equal(serialized.includes(forbidden), false, `persisted state leaked ${forbidden}`);
  }

  const storedRun = compact.sessions[0].runs[0];
  assert.equal(compact.sessions[0].title, 'No-secret privacy regression');
  assert.deepEqual(compact.sessions[0].focusFiles, ['main.tex', 'sections/method.tex']);
  assert.equal(storedRun.status, 'failed');
  assert.equal(storedRun.startedAt, '2026-05-06T00:00:00.000Z');
  assert.equal(storedRun.finishedAt, '2026-05-06T00:01:00.000Z');
  assert.deepEqual(storedRun.attachments, [{
    name: 'figure.png',
    mimeType: 'image/png',
    size: 256,
    kind: 'image'
  }]);
});

test('normalizes previously corrupted history-only sessions into clickable runs', () => {
  const state = normalizePanelState({
    sessions: [{
      id: 'session_corrupted',
      title: 'Grammar pass',
      task: '',
      history: [{
        task: '帮我检查语法',
        result: '结论：发现 3 处语法问题。',
        at: '2026-05-02T17:51:00.134Z'
      }]
    }],
    activeSessionId: 'session_corrupted'
  });

  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].id, 'recovered_session_corrupted_0');
  assert.equal(state.runs[0].task, '帮我检查语法');
  assert.equal(state.runs[0].status, 'completed');
  assert.equal(state.runs[0].events[0].kind, 'report');
  assert.deepEqual(state.runs[0].events[0].detail, {
    '结论': '结论：发现 3 处语法问题。'
  });
});

test('normalizes assistant-visible run and history text without local absolute paths', () => {
  const state = normalizePanelState({
    sessions: [{
      id: 'session_local_paths',
      title: `Manual title ${RAW_LOCAL_PATH}`,
      task: `Task mentions ${RAW_LOCAL_PATH}`,
      history: [{
        task: `History task ${RAW_LOCAL_PATH}`,
        result: `History result ${RAW_LOCAL_PATH_COLUMN}`,
        at: '2026-05-06T00:00:00.000Z'
      }],
      runs: [{
        id: 'run_local_paths',
        task: `Run task ${RAW_LOCAL_PATH}`,
        status: 'completed',
        statusText: `Done after reading ${RAW_LOCAL_PATH}`,
        events: [{
          title: `Stream delta ${RAW_LOCAL_PATH}`,
          status: 'completed',
          kind: 'stream',
          streamKey: 'assistant',
          streamRole: 'assistant',
          detail: {
            userReport: { text: `User report ${RAW_LOCAL_PATH}` },
            assistantMessage: `Assistant message ${RAW_LOCAL_PATH_COLUMN}`,
            finalAnswer: `Final answer ${RAW_LOCAL_PATH}`,
            delta: `Delta ${RAW_LOCAL_PATH}`,
            inlineCode: `\`${RAW_LOCAL_PATH}\``,
            fencedCode: ['```', RAW_LOCAL_PATH_COLUMN, '```'].join('\n')
          }
        }]
      }]
    }],
    activeSessionId: 'session_local_paths'
  });

  assertNoRawLocalPaths(state, 'normalized state');
  assert.match(state.runs[0].events[0].title, /local path|main\.tex/);
});

test('normalizes reloaded history-only run cards without local absolute paths', () => {
  const state = normalizePanelState({
    sessions: [{
      id: 'session_recovered_local_paths',
      title: 'Recovered local path card',
      task: '',
      history: [{
        task: `Reloaded task ${RAW_LOCAL_PATH}`,
        result: `Reloaded final answer ${RAW_LOCAL_PATH_COLUMN}`,
        at: '2026-05-06T00:00:00.000Z'
      }]
    }],
    activeSessionId: 'session_recovered_local_paths'
  });

  assertNoRawLocalPaths(state, 'recovered history run');
  assert.equal(state.runs[0].id, 'recovered_session_recovered_local_paths_0');
  assert.match(state.runs[0].events[0].detail['结论'], /local path|main\.tex/);
});

test('migrates legacy single-session state into a switchable session list', () => {
  const state = normalizePanelState({
    mode: 'confirm',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    speedTier: 'fast',
    requireReviewing: false,
    task: 'legacy draft',
    session: { id: 'session_legacy', history: [{ task: 'old task', result: 'done' }] },
    runs: [{ id: 'run_legacy', task: 'old task', status: 'completed' }]
  });

  assert.equal(state.sessions.length, 1);
  assert.equal(state.activeSessionId, 'session_legacy');
  assert.equal(state.session.id, 'session_legacy');
  assert.equal(state.task, 'legacy draft');
  assert.equal(state.mode, 'confirm');
  assert.equal(state.model, 'gpt-5.5');
  assert.equal(state.reasoningEffort, 'xhigh');
  assert.equal(state.speedTier, 'fast');
  assert.equal(state.requireReviewing, false);
  assert.equal(state.runs[0].id, 'run_legacy');
  assert.equal(getActiveSession(state).runs[0].id, 'run_legacy');
});

test('switches active session while preserving project-wide model settings', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_b',
    providerId: 'builtin',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    speedTier: 'standard',
    sessions: [{
      id: 'session_a',
      title: 'A',
      task: 'draft a',
      mode: 'auto',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      speedTier: 'standard',
      runs: [{ id: 'run_a', task: 'task a', status: 'completed' }]
    }, {
      id: 'session_b',
      title: 'B',
      task: 'draft b',
      mode: 'confirm',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      speedTier: 'fast',
      runs: [{ id: 'run_b', task: 'task b', status: 'completed' }]
    }]
  });

  assert.equal(state.session.id, 'session_b');
  assert.equal(state.task, 'draft b');
  assert.equal(state.mode, 'confirm');
  assert.equal(state.providerId, 'builtin');
  assert.equal(state.model, 'gpt-5.4');
  assert.equal(state.reasoningEffort, 'high');
  assert.equal(state.speedTier, 'standard');
  assert.equal(state.runs[0].id, 'run_b');
});

test('updates active session without mutating inactive sessions', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_b',
    sessions: [
      { id: 'session_a', title: 'A', task: 'draft a', runs: [] },
      { id: 'session_b', title: 'B', task: 'draft b', runs: [] }
    ]
  });

  const updated = updateActiveSession(state, {
    task: 'new draft',
    runs: [{ id: 'run_new', task: 'new draft', status: 'completed' }]
  });

  assert.equal(updated.sessions[0].task, 'draft a');
  assert.equal(updated.sessions[1].task, 'new draft');
  assert.equal(updated.task, 'new draft');
  assert.equal(updated.runs[0].id, 'run_new');
});

test('keeps in-memory running runs active while switching sessions', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_a',
    sessions: [
      { id: 'session_a', title: 'A', runs: [] },
      { id: 'session_b', title: 'B', runs: [{ id: 'run_b', task: 'task b', status: 'running' }] }
    ]
  });

  const switched = setActiveSession(state, 'session_b');

  assert.equal(switched.session.id, 'session_b');
  assert.equal(switched.runs[0].status, 'running');
  assert.equal(switched.runs[0].events.length, 0);
});

test('deletes inactive sessions without changing the active session', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_b',
    sessions: [
      { id: 'session_a', title: 'A', runs: [{ id: 'run_a', task: 'task a', status: 'completed' }] },
      { id: 'session_b', title: 'B', task: 'draft b', runs: [{ id: 'run_b', task: 'task b', status: 'completed' }] }
    ]
  });

  const updated = deleteSession(state, 'session_a');

  assert.deepEqual(updated.sessions.map(session => session.id), ['session_b']);
  assert.equal(updated.activeSessionId, 'session_b');
  assert.equal(updated.session.id, 'session_b');
  assert.equal(updated.task, 'draft b');
  assert.equal(updated.runs[0].id, 'run_b');
});

test('deletes active sessions and switches to the most recent remaining session', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_b',
    sessions: [
      { id: 'session_a', title: 'A', updatedAt: '2026-05-01T10:00:00.000Z', runs: [] },
      { id: 'session_b', title: 'B', updatedAt: '2026-05-01T11:00:00.000Z', runs: [] },
      { id: 'session_c', title: 'C', updatedAt: '2026-05-01T12:00:00.000Z', task: 'draft c', runs: [] }
    ]
  });

  const updated = deleteSession(state, 'session_b');

  assert.deepEqual(updated.sessions.map(session => session.id), ['session_a', 'session_c']);
  assert.equal(updated.activeSessionId, 'session_c');
  assert.equal(updated.session.id, 'session_c');
  assert.equal(updated.task, 'draft c');
});

test('deleting the final session creates a fresh empty active session', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_only',
    mode: 'confirm',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    sessions: [
      { id: 'session_only', title: 'Only', task: 'draft', mode: 'confirm', model: 'gpt-5.5', reasoningEffort: 'xhigh', runs: [] }
    ]
  });

  const updated = deleteSession(state, 'session_only');

  assert.equal(updated.sessions.length, 1);
  assert.notEqual(updated.session.id, 'session_only');
  assert.equal(updated.session.id, updated.activeSessionId);
  assert.equal(updated.task, '');
  assert.deepEqual(updated.runs, []);
  assert.equal(updated.mode, 'confirm');
  assert.equal(updated.model, 'gpt-5.5');
  assert.equal(updated.reasoningEffort, 'xhigh');
});

test('normalizes bounded persisted run history for the panel', () => {
  const state = normalizePanelState({
    runs: Array.from({ length: 24 }, (_, index) => ({
      id: `run_${index}`,
      task: `task ${index}`,
      status: index % 2 ? 'completed' : 'running',
      events: [{ title: `event ${index}` }],
      undoOperations: index === 23 ? [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }] : [],
      undoBaseFiles: index === 23 ? [{ path: 'main.tex', content: 'after' }] : []
    }))
  });

  assert.equal(state.runs.length, 20);
  assert.equal(state.runs[0].id, 'run_4');
  assert.equal(state.runs[19].id, 'run_23');
  assert.equal(state.runs[19].status, 'completed');
  assert.deepEqual(state.runs[19].undoOperations, [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }]);
  assert.deepEqual(state.runs[19].undoBaseFiles, [{ path: 'main.tex', content: 'after' }]);
});

test('preserves stream metadata and enough processing history for completed runs', () => {
  const state = normalizePanelState({
    runs: [{
      id: 'run_stream_history',
      task: 'check references',
      status: 'completed',
      events: Array.from({ length: 120 }, (_, index) => index === 119
        ? {
          title: 'Final answer',
          status: 'completed',
          kind: 'stream',
          streamKey: 'agent:final',
          streamRole: 'assistant'
        }
        : {
          title: `process ${index}`,
          status: 'running',
          kind: 'activity'
        })
    }]
  });

  assert.equal(state.runs[0].events.length, 120);
  const final = state.runs[0].events.at(-1);
  assert.equal(final.kind, 'stream');
  assert.equal(final.streamKey, 'agent:final');
  assert.equal(final.streamRole, 'assistant');
});

test('marks restored persisted running runs as no longer tracked after reload', () => {
  const state = normalizePanelState({
    runs: [{
      id: 'run_active',
      task: 'still running before reload',
      status: 'running',
      statusText: 'Running',
      events: [{ title: 'Codex exec started', status: 'running' }]
    }]
  }, {
    restoreRunningRuns: true
  });

  // v1.7.5: reload-orphaned runs are 'interrupted', not 'failed', and the
  // notice is a report-kind event with a retryable failure code so the
  // recovery registry offers "Edit & resend" on the card.
  assert.equal(state.runs[0].status, 'interrupted');
  assert.equal(state.runs[0].statusText, 'Stopped tracking after a page refresh');
  assert.equal(state.runs[0].events[1].title, 'Stopped tracking this run after a page refresh');
  assert.equal(state.runs[0].events[1].kind, 'report');
  assert.equal(state.runs[0].events[1].failure.code, 'native_request_failed');
});

test('localizes restored running run stop messages when locale is Chinese', () => {
  const state = normalizePanelState({
    locale: 'zh',
    runs: [{
      id: 'run_active',
      task: 'still running before reload',
      status: 'running',
      statusText: 'Running',
      events: [{ title: 'Codex exec started', status: 'running' }]
    }]
  }, {
    restoreRunningRuns: true
  });

  assert.equal(state.runs[0].status, 'interrupted');
  assert.equal(state.runs[0].statusText, '页面刷新后已停止跟踪');
  assert.equal(state.runs[0].events[1].title, '页面刷新后已停止跟踪这轮任务');
  assert.equal(
    state.runs[0].events[1].detail,
    '插件重新加载时发现这轮任务还标记为处理中。为了避免继续显示过期状态，已把它标记为中断；可以重新运行任务。'
  );
});

test('prepares a compact persisted state without storing huge historical payloads', () => {
  const largeText = 'x'.repeat(20000);
  const undoText = 'u'.repeat(120000);
  const state = normalizePanelState({
    activeSessionId: 'session_heavy',
    sessions: [{
      id: 'session_heavy',
      title: 'Heavy',
      task: 'Inspect a large manuscript',
      runs: Array.from({ length: 12 }, (_, index) => ({
        id: `run_${index}`,
        task: `task ${index}`,
        status: 'completed',
        events: Array.from({ length: 20 }, (__, eventIndex) => ({
          title: `**reasoning ${eventIndex}** ${largeText}`,
          detail: { raw: largeText },
          technicalDetail: { raw: largeText },
          kind: eventIndex % 2 ? 'stream' : 'activity'
        })),
        undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: undoText }],
        undoBaseFiles: [
          { path: 'main.tex', content: undoText }
        ]
      }))
    }]
  });

  const compact = prepareStateForStorage(state);
  const activeStoredSession = compact.sessions.find(session => session.id === compact.activeSessionId);

  assert.ok(estimateJsonBytes(compact) < 4 * 1024 * 1024);
  assert.equal(compact.runs.length, 0);
  assert.equal(activeStoredSession.runs.length, 10);
  assert.equal(activeStoredSession.runs[0].events.length, 20);
  assert.equal(activeStoredSession.runs[0].events[0].technicalDetail, undefined);
  assert.ok(activeStoredSession.runs[0].events[0].title.length < 6100);
  assert.equal(activeStoredSession.runs[0].undoOperations.length, 0);
  assert.equal(activeStoredSession.runs.at(-1).undoOperations.length, 0);
});

test('storage compaction summarizes long final reports instead of persisting report bodies', () => {
  const reportBody = [
    '结论：我检查了全文。',
    '',
    '### 1) 数学和引用',
    '- [paper.tex:486](/Users/example/.codex-overleaf/projects/p/workspace/paper.tex:486)：`\\eqref{eq:cmdp_obj}` 当前标签不存在。',
    'x'.repeat(8000),
    'END_REPORT_MARKER'
  ].join('\n');
  const activityDetail = `${'y'.repeat(8000)}END_ACTIVITY_MARKER`;
  const state = normalizePanelState({
    sessions: [createSession({
      title: 'Long summary',
      runs: [{
        id: 'run_long_report',
        task: '检查证明',
        status: 'completed',
        events: [
          {
            title: '本地检查已完成',
            status: 'completed',
            kind: 'activity',
            detail: activityDetail
          },
          {
            title: '本轮完成报告',
            status: 'completed',
            kind: 'report',
            detail: reportBody
          }
        ]
      }]
    })]
  });

  const compact = prepareStateForStorage(state);
  const run = compact.sessions[0].runs[0];
  const activity = run.events.find(event => event.kind === 'activity');
  const report = run.events.find(event => event.kind === 'report');

  assert.match(report.detail, /^\[detail omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
  assert.match(activity.detail, /^\[detail omitted; chars=\d+; hash=[a-f0-9]{8}\]$/);
  assert.doesNotMatch(JSON.stringify(compact), /END_REPORT_MARKER/);
  assert.doesNotMatch(JSON.stringify(compact), /END_ACTIVITY_MARKER/);
  assert.doesNotMatch(JSON.stringify(compact), /\[paper\.tex:486\]\(/);
});

test('aggressive storage preparation preserves the active session essentials under a smaller cap', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_active',
    sessions: Array.from({ length: 16 }, (_, index) => ({
      id: index === 1 ? 'session_active' : `session_${index}`,
      title: `Session ${index}`,
      task: `task ${index} ${'x'.repeat(10000)}`,
      runs: Array.from({ length: 8 }, (__, runIndex) => ({
        id: `run_${index}_${runIndex}`,
        task: `run ${runIndex}`,
        status: 'completed',
        events: Array.from({ length: 80 }, (___, eventIndex) => ({
          title: `event ${eventIndex} ${'y'.repeat(5000)}`,
          detail: { text: 'z'.repeat(5000) }
        }))
      }))
    }))
  });

  const compact = prepareStateForStorage(state, { aggressive: true });

  assert.ok(estimateJsonBytes(compact) < 768 * 1024);
  assert.equal(compact.activeSessionId, 'session_active');
  assert.equal(compact.sessions.some(session => session.id === 'session_active'), true);
  const activeStoredSession = compact.sessions.find(session => session.id === compact.activeSessionId);
  assert.equal(compact.runs.length, 0);
  assert.ok(activeStoredSession.runs.length <= 3);
  assert.ok(activeStoredSession.runs.every(run => run.events.length <= 20));
});

test('prepareStateForStorage redacts local absolute paths on compact and aggressive paths', () => {
  const rawState = {
    activeSessionId: 'session_storage_local_paths',
    focusFiles: [RAW_LOCAL_PATH],
    sessions: [{
      id: 'session_storage_local_paths',
      title: `Storage local path ${RAW_LOCAL_PATH}`,
      titleSource: 'manual',
      task: `Storage task ${RAW_LOCAL_PATH}`,
      focusFiles: [RAW_LOCAL_PATH],
      history: [{
        task: `Storage history task ${RAW_LOCAL_PATH}`,
        result: `Storage history result ${RAW_LOCAL_PATH_COLUMN}`,
        at: '2026-05-06T00:00:00.000Z'
      }],
      runs: [{
        id: 'run_storage_local_paths',
        task: `Run task ${RAW_LOCAL_PATH}`,
        status: 'completed',
        statusText: `Status ${RAW_LOCAL_PATH}`,
        events: [{
          title: `Event title ${RAW_LOCAL_PATH}`,
          status: 'completed',
          kind: 'report',
          detail: {
            userReport: `Structured userReport ${RAW_LOCAL_PATH}`,
            assistantMessage: `Assistant message ${RAW_LOCAL_PATH_COLUMN}`,
            finalAnswer: `Final answer ${RAW_LOCAL_PATH}`,
            path: RAW_LOCAL_PATH
          }
        }, {
          title: 'Code report',
          status: 'completed',
          kind: 'activity',
          detail: [
            `Inline \`${RAW_LOCAL_PATH}\``,
            '```',
            RAW_LOCAL_PATH_COLUMN,
            '```'
          ].join('\n')
        }]
      }]
    }]
  };

  const compact = prepareStateForStorage(rawState);
  const aggressive = prepareStateForStorage(rawState, { aggressive: true });

  assertNoRawLocalPaths(compact, 'compact storage state');
  assertNoRawLocalPaths(aggressive, 'aggressive storage state');
});

test('normalizeSession preserves codexThreadId', () => {
  const state = normalizePanelState({
    sessions: [{ id: 'sess1', codexThreadId: 'thread_abc', title: 'test' }],
    activeSessionId: 'sess1'
  });
  const session = state.sessions[0];
  assert.strictEqual(session.codexThreadId, 'thread_abc');
});

test('updateActiveSession can set codexThreadId', () => {
  let state = normalizePanelState({
    sessions: [{ id: 'sess1', title: 'test' }],
    activeSessionId: 'sess1'
  });
  state = updateActiveSession(state, { codexThreadId: 'thread_xyz' });
  assert.strictEqual(state.sessions[0].codexThreadId, 'thread_xyz');
  assert.strictEqual(state.session.codexThreadId, 'thread_xyz');
});

test('createSession defaults codexThreadId to empty string', () => {
  const session = createSession({});
  assert.strictEqual(session.codexThreadId, '');
});

const STABLE_TRACKED_CHANGE_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'needs_review'
];
const TERMINAL_TRACKED_CHANGE_STATUSES = ['accepted', 'rejected'];
// Values from the superseded partial / closed-ledger model. They must never be
// kept as-is; normalization recovers them like any other non-stable value.
const SUPERSEDED_TRACKED_CHANGE_STATUSES = ['partial_accept', 'partial_reject', 'resolved_elsewhere'];

function trackedChangeRefs() {
  return [{ key: 'tc-1', id: 'change-1', path: 'main.tex', label: 'Change 1' }];
}

function normalizeRun(run, options) {
  return normalizeRuns([run], options)[0];
}

for (const status of STABLE_TRACKED_CHANGE_STATUSES) {
  test(`normalizeRun keeps the stable trackedChangeStatus value "${status}"`, () => {
    const run = normalizeRun({
      id: 'run_tc',
      task: 'tracked change run',
      status: 'completed',
      trackedChangeStatus: status,
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    });

    assert.equal(run.trackedChangeStatus, status);
  });
}

test('normalizeRun migrates a pre-feature run with refs and a non-applied undoStatus to pending', () => {
  const run = normalizeRun({
    id: 'run_tc',
    task: 'tracked change run',
    status: 'completed',
    undoTrackedChanges: trackedChangeRefs(),
    undoExpectedFiles: [{ path: 'main.tex', content: 'after' }],
    undoStatus: ''
  });

  assert.equal(run.trackedChangeStatus, 'pending');
  assert.equal(run.undoTrackedChanges.length, 1);
  assert.equal(run.undoExpectedFiles.length, 1);
});

test('normalizeRun migrates a pre-feature run with refs and undoStatus "applied" to rejected and empties the payload', () => {
  const run = normalizeRun({
    id: 'run_tc',
    task: 'tracked change run',
    status: 'completed',
    undoTrackedChanges: trackedChangeRefs(),
    undoExpectedFiles: [{ path: 'main.tex', content: 'after' }],
    undoStatus: 'applied'
  });

  assert.equal(run.trackedChangeStatus, 'rejected');
  assert.deepEqual(run.undoTrackedChanges, []);
  assert.deepEqual(run.undoExpectedFiles, []);
});

test('normalizeRun leaves a run with no trackedChangeStatus and no tracked-change refs as a legacy-undo run', () => {
  const run = normalizeRun({
    id: 'run_legacy',
    task: 'legacy undo run',
    status: 'completed',
    undoTrackedChanges: [],
    undoExpectedFiles: []
  });

  assert.equal('trackedChangeStatus' in run, false);
});

test('normalizeRun recovers a stray trackedChangeStatus value to pending when refs are present', () => {
  for (const stray of ['accepting', 'bogus']) {
    const run = normalizeRun({
      id: 'run_stray',
      task: 'stray status run',
      status: 'completed',
      trackedChangeStatus: stray,
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    });

    assert.equal(run.trackedChangeStatus, 'pending', `stray "${stray}" with refs`);
  }
});

test('normalizeRun drops a stray trackedChangeStatus value when no tracked-change refs are present', () => {
  for (const stray of ['accepting', 'bogus']) {
    const run = normalizeRun({
      id: 'run_stray',
      task: 'stray status run',
      status: 'completed',
      trackedChangeStatus: stray,
      undoTrackedChanges: [],
      undoExpectedFiles: []
    });

    assert.equal('trackedChangeStatus' in run, false, `stray "${stray}" without refs`);
  }
});

test('normalizeRun recovers an old persisted partial_* / resolved_elsewhere value to pending when refs are present', () => {
  for (const superseded of SUPERSEDED_TRACKED_CHANGE_STATUSES) {
    const run = normalizeRun({
      id: 'run_superseded',
      task: 'superseded status run',
      status: 'completed',
      trackedChangeStatus: superseded,
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    });

    assert.equal(run.trackedChangeStatus, 'pending', `superseded "${superseded}" with refs`);
  }
});

test('normalizeRun drops an old persisted partial_* / resolved_elsewhere value when no refs are present', () => {
  for (const superseded of SUPERSEDED_TRACKED_CHANGE_STATUSES) {
    const run = normalizeRun({
      id: 'run_superseded',
      task: 'superseded status run',
      status: 'completed',
      trackedChangeStatus: superseded,
      undoTrackedChanges: [],
      undoExpectedFiles: []
    });

    assert.equal('trackedChangeStatus' in run, false, `superseded "${superseded}" without refs`);
  }
});

for (const terminal of TERMINAL_TRACKED_CHANGE_STATUSES) {
  test(`normalizeRun empties the payload for terminal trackedChangeStatus "${terminal}" but keeps the status`, () => {
    const run = normalizeRun({
      id: 'run_terminal',
      task: 'terminal run',
      status: 'completed',
      trackedChangeStatus: terminal,
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    });

    assert.equal(run.trackedChangeStatus, terminal);
    assert.deepEqual(run.undoTrackedChanges, []);
    assert.deepEqual(run.undoExpectedFiles, []);
  });
}

test('normalizeRun trackedChangeStatus normalization is idempotent', () => {
  const cases = [
    ...STABLE_TRACKED_CHANGE_STATUSES.map(status => ({
      id: 'run_idem',
      task: 'idempotence run',
      status: 'completed',
      trackedChangeStatus: status,
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    })),
    {
      id: 'run_idem',
      task: 'idempotence run',
      status: 'completed',
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }],
      undoStatus: ''
    },
    {
      id: 'run_idem',
      task: 'idempotence run',
      status: 'completed',
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }],
      undoStatus: 'applied'
    },
    {
      id: 'run_idem',
      task: 'idempotence run',
      status: 'completed',
      undoTrackedChanges: [],
      undoExpectedFiles: []
    },
    {
      id: 'run_idem',
      task: 'idempotence run',
      status: 'completed',
      trackedChangeStatus: 'accepting',
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    },
    {
      id: 'run_idem',
      task: 'idempotence run',
      status: 'completed',
      trackedChangeStatus: 'bogus',
      undoTrackedChanges: [],
      undoExpectedFiles: []
    },
    ...SUPERSEDED_TRACKED_CHANGE_STATUSES.map(superseded => ({
      id: 'run_idem',
      task: 'idempotence run',
      status: 'completed',
      trackedChangeStatus: superseded,
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    }))
  ];

  for (const input of cases) {
    const once = normalizeRun(input);
    const twice = normalizeRun(once);
    assert.deepEqual(twice, once);
  }
});

const NON_TERMINAL_TRACKED_CHANGE_STATUSES = ['pending', 'needs_review'];

for (const status of NON_TERMINAL_TRACKED_CHANGE_STATUSES) {
  test(`normalizeRun drops a non-terminal trackedChangeStatus "${status}" when the reloaded run has no tracked-change refs`, () => {
    const run = normalizeRun({
      id: 'run_reloaded',
      task: 'reloaded tracked change run',
      status: 'completed',
      trackedChangeStatus: status,
      undoTrackedChanges: [],
      undoExpectedFiles: []
    });

    assert.equal('trackedChangeStatus' in run, false, `non-terminal "${status}" with no refs`);
  });
}

for (const status of NON_TERMINAL_TRACKED_CHANGE_STATUSES) {
  test(`normalizeRun keeps a non-terminal trackedChangeStatus "${status}" when tracked-change refs are present`, () => {
    const run = normalizeRun({
      id: 'run_live',
      task: 'live tracked change run',
      status: 'completed',
      trackedChangeStatus: status,
      undoTrackedChanges: trackedChangeRefs(),
      undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
    });

    assert.equal(run.trackedChangeStatus, status, `non-terminal "${status}" with refs`);
  });
}

for (const terminal of TERMINAL_TRACKED_CHANGE_STATUSES) {
  test(`normalizeRun keeps a terminal trackedChangeStatus "${terminal}" when the reloaded run has no tracked-change refs`, () => {
    const run = normalizeRun({
      id: 'run_reloaded_terminal',
      task: 'reloaded terminal run',
      status: 'completed',
      trackedChangeStatus: terminal,
      undoTrackedChanges: [],
      undoExpectedFiles: []
    });

    assert.equal(run.trackedChangeStatus, terminal, `terminal "${terminal}" with no refs`);
  });
}

test('normalizeRun reload reconciliation is idempotent', () => {
  const cases = [
    ...NON_TERMINAL_TRACKED_CHANGE_STATUSES.map(status => ({
      id: 'run_recon_idem',
      task: 'reconciliation idempotence run',
      status: 'completed',
      trackedChangeStatus: status,
      undoTrackedChanges: [],
      undoExpectedFiles: []
    })),
    ...TERMINAL_TRACKED_CHANGE_STATUSES.map(terminal => ({
      id: 'run_recon_idem',
      task: 'reconciliation idempotence run',
      status: 'completed',
      trackedChangeStatus: terminal,
      undoTrackedChanges: [],
      undoExpectedFiles: []
    }))
  ];

  for (const input of cases) {
    const once = normalizeRun(input);
    const twice = normalizeRun(once);
    assert.deepEqual(twice, once);
  }
});

test('trackedChangeStatus survives storage compaction as a lightweight field', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_tc',
    sessions: [{
      id: 'session_tc',
      title: 'Tracked change session',
      runs: [{
        id: 'run_tc_accepted',
        task: 'accepted tracked change run',
        status: 'completed',
        trackedChangeStatus: 'accepted'
      }, {
        id: 'run_tc_pending',
        task: 'pending tracked change run',
        status: 'completed',
        trackedChangeStatus: 'pending',
        undoTrackedChanges: trackedChangeRefs(),
        undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
      }]
    }]
  });

  const compact = prepareStateForStorage(state);
  const runs = compact.sessions[0].runs;

  assert.equal(runs.find(run => run.id === 'run_tc_accepted').trackedChangeStatus, 'accepted');
  assert.equal(runs.find(run => run.id === 'run_tc_pending').trackedChangeStatus, 'pending');
});

test('normalizeRuns round-trips trackedChangeStatus "needs_review" as a stable non-terminal value', () => {
  // needs_review is the §7 settlement state surfaced when Accept/Undo cannot
  // prove a clean post-action state. It must survive normalization (step 1
  // value recovery), the migration step must leave it alone, and the terminal
  // cleanup step must not strip the refs (the user is supposed to retry).
  const run = normalizeRun({
    id: 'run_needs_review',
    task: 'tracked change run needing review',
    status: 'completed',
    trackedChangeStatus: 'needs_review',
    undoTrackedChanges: trackedChangeRefs(),
    undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
  });

  assert.equal(run.trackedChangeStatus, 'needs_review');
  // needs_review is non-terminal — the refs and expected files survive so the
  // user can retry Accept/Undo after inspecting Overleaf.
  assert.equal(run.undoTrackedChanges.length, 1);
  assert.equal(run.undoExpectedFiles.length, 1);
});

test('storageDb compactRunForStorage round-trips trackedChangeStatus "needs_review"', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_tc_nr',
    sessions: [{
      id: 'session_tc_nr',
      title: 'Needs review session',
      runs: [{
        id: 'run_tc_needs_review',
        task: 'needs-review tracked change run',
        status: 'completed',
        trackedChangeStatus: 'needs_review',
        undoTrackedChanges: trackedChangeRefs(),
        undoExpectedFiles: [{ path: 'main.tex', content: 'after' }]
      }]
    }]
  });

  const compact = prepareStateForStorage(state);
  const runs = compact.sessions[0].runs;

  assert.equal(runs.find(run => run.id === 'run_tc_needs_review').trackedChangeStatus, 'needs_review');
});

// ---------------------------------------------------------------------------
// runStatus enum extension (welcome-panel + write-guard v1.3.8 add-on, Task 2)
// `normalizeRunStatus` must accept the three new post-navigation status values
// so a settled run persisted with one of them round-trips intact, and it must
// defensively recover any unknown legacy value to `pending` (the existing safe
// default) without throwing.
// ---------------------------------------------------------------------------
test('runStatus normalizer accepts background_completed', () => {
  const out = normalizeRuns([{ id: 'r', task: 't', mode: 'auto', status: 'background_completed' }]);
  assert.equal(out[0].status, 'background_completed');
});

test('runStatus normalizer accepts needs_review_after_navigation', () => {
  const out = normalizeRuns([{ id: 'r', task: 't', mode: 'auto', status: 'needs_review_after_navigation' }]);
  assert.equal(out[0].status, 'needs_review_after_navigation');
});

test('runStatus normalizer accepts abandoned_after_navigation', () => {
  const out = normalizeRuns([{ id: 'r', task: 't', mode: 'auto', status: 'abandoned_after_navigation' }]);
  assert.equal(out[0].status, 'abandoned_after_navigation');
});

test('runStatus normalizer recovers unknown legacy value to pending', () => {
  const out = normalizeRuns([{ id: 'r', task: 't', mode: 'auto', status: 'totally_unknown_value' }]);
  assert.equal(out[0].status, 'pending', JSON.stringify(out[0]));
});

// ---------------------------------------------------------------------------
// computeSafeTaskSummary + saveState field writes (welcome-panel + write-guard
// v1.3.8 add-on, Task 3). The Recent-projects dashboard variant renders one
// sanitized line per project, never the raw `task`. `computeSafeTaskSummary`
// is the privacy floor. Spec §5.6.2 says the `@` regex must be left broad —
// future implementers must NOT narrow it to "only attachment tokens".
// ---------------------------------------------------------------------------
test('computeSafeTaskSummary strips absolute paths and @-attachments and caps at 80 chars', () => {
  const raw = 'Rewrite section 2 with @section and use the bib at /Users/alice/work/refs.bib\n\nthen also see C:\\Users\\bob\\appendix.tex which is long enough to exceed eighty chars combined';
  const out = computeSafeTaskSummary(raw);
  assert.ok(out.length <= 80, 'summary capped at 80 chars: got length ' + out.length);
  assert.ok(!out.includes('/Users/alice'), 'unix path removed');
  assert.ok(!out.includes('C:\\Users'), 'windows path removed');
  assert.ok(!out.includes('@section'), '@-attachment over-redacted by design');
  assert.ok(!out.includes('\n'), 'newlines collapsed');
});

test('computeSafeTaskSummary returns empty string for non-string / empty input', () => {
  assert.equal(computeSafeTaskSummary(null), '');
  assert.equal(computeSafeTaskSummary(undefined), '');
  assert.equal(computeSafeTaskSummary(''), '');
  assert.equal(computeSafeTaskSummary(42), '');
});

test('computeSafeTaskSummary collapses runs of whitespace to a single space', () => {
  const out = computeSafeTaskSummary('a\t\t  b\n\n  c   d');
  assert.equal(out, 'a b c d');
});

test('computeSafeTaskSummary over-redacts plain @ tokens (emails, handles) by design — spec §5.6.2', () => {
  // Intentional: do NOT narrow this regex. Plain emails / handles are stripped
  // because narrowing the pattern to "only attachment tokens" would re-expose
  // user info / paths / handles in task text.
  const out = computeSafeTaskSummary('please email alice@example.com and ping @bob');
  assert.ok(!out.includes('alice@example.com'), 'plain email over-redacted: ' + out);
  assert.ok(!out.includes('@bob'), 'social handle over-redacted: ' + out);
  assert.ok(out.includes('@…'), 'redaction marker present: ' + out);
});

test('computeSafeTaskSummary strips /home/... and /private/var/... absolute paths', () => {
  const out = computeSafeTaskSummary('see /home/charlie/refs.bib and /private/var/tmp/log.txt');
  assert.ok(!out.includes('/home/charlie'));
  assert.ok(!out.includes('/private/var/tmp'));
  assert.ok(out.includes('<local-path>'));
});

test('computeSafeTaskSummary truncates with … when over 80 chars', () => {
  const out = computeSafeTaskSummary('x'.repeat(200));
  assert.equal(out.length, 80);
  assert.ok(out.endsWith('…'));
});

// ---------------------------------------------------------------------------
// Welcome-panel + write-guard v1.3.8 add-on FX1 (Fix C / spec §5.6.2):
// `computeSafeTaskSummary` must redact the broad family of absolute local
// path shapes — not just the four hand-rolled patterns the original T3
// shipped with. The fix extracts a shared `pathRedaction` helper used by
// BOTH this summary path AND the storage-side audit redactor so the regex
// set stays in sync and adding a new shape is a one-line change.
// ---------------------------------------------------------------------------

// Fix C: parameterized per-path-shape tests. Each shape is a distinct test
// so failures pinpoint exactly which path family regressed. The original
// substring must be gone from the output; the placeholder token itself is
// not load-bearing (the spec accepts either '<local-path>' or '[local
// path]').
const FIX_C_PATH_CASES = [
  { name: '/Users/alice',         input: 'see /Users/alice/foo for ref' },
  { name: '/home/bob',            input: 'see /home/bob/foo for ref' },
  { name: '/private/var',         input: 'see /private/var/foo for ref' },
  { name: '/tmp',                 input: 'see /tmp/foo for ref' },
  { name: '/var/folders',         input: 'see /var/folders/abc/foo for ref' },
  { name: '/Volumes/USB',         input: 'see /Volumes/USB/foo for ref' },
  { name: 'file:///Users/alice',  input: 'see file:///Users/alice/foo for ref' },
  { name: 'C:\\Users\\bob',       input: 'see C:\\Users\\bob\\foo for ref' },
  { name: 'C:/Users/bob',         input: 'see C:/Users/bob/foo for ref' },
  { name: '\\\\server\\share',    input: 'see \\\\server\\share\\foo for ref' }
];
for (const c of FIX_C_PATH_CASES) {
  test(`Fix C: computeSafeTaskSummary redacts ${c.name}`, () => {
    const out = computeSafeTaskSummary(c.input);
    assert.ok(!out.includes(c.name), `${c.name} must be redacted out (got: ${JSON.stringify(out)})`);
  });
}

test('Fix C: computeSafeTaskSummary redacts the local Codex workspace path under any prefix', () => {
  // The audit redactor already catches `.codex-overleaf/projects/...` paths;
  // the shared helper must keep that coverage so the dashboard summary
  // never surfaces a per-project local workspace path.
  const out = computeSafeTaskSummary('relative ./.codex-overleaf/projects/proj_abc/main.tex here');
  assert.ok(!out.includes('proj_abc'), '.codex-overleaf workspace path must be redacted: ' + out);
});

test('Fix C: shared pathRedaction helper exists and covers the spec\'s path families', () => {
  // Source-level sanity: the extracted helper is the spec\'s recommended
  // shape. Tests above already cover the behavior; this asserts the helper
  // is in place so future implementers find it instead of duplicating the
  // pattern set inside another sanitizer.
  const PathRedaction = require('../extension/src/shared/pathRedaction');
  assert.ok(PathRedaction.redactLocalPaths instanceof Function,
    'pathRedaction.redactLocalPaths must be exported');
  // Spot-check a known-positive and a known-negative.
  assert.equal(PathRedaction.redactLocalPaths('/Users/alice/foo'), '<local-path>');
  assert.equal(PathRedaction.redactLocalPaths('plain text with no paths'), 'plain text with no paths');
});

test('saveState round-trip writes lastActivityAt, accountScopeId, safeTaskSummary on the active session record', () => {
  // We exercise the storage round-trip end-to-end: build a session record via
  // the inner record builder and assert the four Recent-projects fields are
  // populated. T3 stores the four fields on every persisted session record so
  // the cross-project query can filter them; T4 hooks up the real derive fn.
  const StorageDb = require('../extension/src/shared/storageDb');
  const prior = global.window;
  global.window = { codexOverleafDeriveAccountScopeId: () => 'acct_test_scope_001' };
  try {
    const record = StorageDb.buildSessionRecord({
      id: 'ses_active',
      projectId: 'proj_a',
      task: 'rewrite section 2 with bib refs',
      updatedAt: '2026-05-25T10:00:00.000Z'
    });
    assert.equal(record.lastActivityAt, '2026-05-25T10:00:00.000Z', 'lastActivityAt mirrors updatedAt');
    assert.equal(record.accountScopeId, 'acct_test_scope_001');
    assert.equal(record.accountScopeUnavailable, false);
    assert.equal(record.safeTaskSummary, 'rewrite section 2 with bib refs');
  } finally {
    global.window = prior;
  }
});

test('saveState round-trip sets accountScopeUnavailable=true when the derive fn returns null', () => {
  const StorageDb = require('../extension/src/shared/storageDb');
  const prior = global.window;
  global.window = { codexOverleafDeriveAccountScopeId: () => null };
  try {
    const record = StorageDb.buildSessionRecord({
      id: 'ses_no_scope',
      projectId: 'proj_b',
      task: 'short task'
    });
    assert.equal(record.accountScopeId, null);
    assert.equal(record.accountScopeUnavailable, true);
    assert.equal(record.safeTaskSummary, 'short task');
    assert.ok(typeof record.lastActivityAt === 'string' && record.lastActivityAt.length > 0,
      'lastActivityAt is present even in degraded mode');
  } finally {
    global.window = prior;
  }
});

test('saveState round-trip falls back to () => null when no derive fn is injected', () => {
  const StorageDb = require('../extension/src/shared/storageDb');
  const prior = global.window;
  global.window = {}; // no injection point installed
  try {
    const record = StorageDb.buildSessionRecord({
      id: 'ses_no_inject',
      projectId: 'proj_c',
      task: 'task body'
    });
    assert.equal(record.accountScopeId, null);
    assert.equal(record.accountScopeUnavailable, true);
  } finally {
    global.window = prior;
  }
});

test('saveState round-trip derives safeTaskSummary from runs[0].task when session.task is empty', () => {
  const StorageDb = require('../extension/src/shared/storageDb');
  const prior = global.window;
  global.window = { codexOverleafDeriveAccountScopeId: () => 'acct_x' };
  try {
    const record = StorageDb.buildSessionRecord({
      id: 'ses_runs_only',
      projectId: 'proj_d',
      task: '',
      runs: [{ id: 'run_1', task: 'fallback task from runs', mode: 'auto' }]
    });
    assert.equal(record.safeTaskSummary, 'fallback task from runs');
  } finally {
    global.window = prior;
  }
});

test('report events keep compileErrors and failure across normalization, and aggressive compaction fires onAggressive (v1.7.5)', () => {
  const state = normalizePanelState({
    activeSessionId: 'session_a',
    sessions: [{
      id: 'session_a',
      title: 'A',
      runs: [{
        id: 'run_1',
        task: 'fix the intro',
        status: 'failed',
        events: [{
          title: 'Report',
          kind: 'report',
          status: 'failed',
          detail: 'Compile failed',
          failure: { code: 'codex_timeout' },
          compileErrors: ['Undefined control sequence \\foo', 'Missing $ inserted', '', 3, 'e4', 'e5', 'e6-over-cap'],
          rejectedHunks: [{ path: 'main.tex', summary: 'L12: new intro' }, { path: '', summary: 'dropped: no path' }]
        }]
      }]
    }]
  });

  const event = state.sessions[0].runs[0].events[0];
  assert.equal(event.failure.code, 'codex_timeout',
    'structured failure survives normalization (recovery buttons depend on it)');
  assert.deepEqual(event.compileErrors, ['Undefined control sequence \\foo', 'Missing $ inserted', '3', 'e4'],
    'compileErrors take the first five entries, stringified, with empties dropped');
  assert.deepEqual(event.rejectedHunks, [{ path: 'main.tex', summary: 'L12: new intro' }],
    'rejectedHunks keep {path, summary} and drop entries without a path');

  // prepareStateForStorage keeps both fields through the compaction path.
  const compact = prepareStateForStorage(state);
  const compactEvent = compact.sessions[0].runs[0].events[0];
  assert.equal(compactEvent.failure.code, 'codex_timeout');
  assert.deepEqual(compactEvent.compileErrors.slice(0, 2), ['Undefined control sequence \\foo', 'Missing $ inserted']);
  assert.deepEqual(compactEvent.rejectedHunks, [{ path: 'main.tex', summary: 'L12: new intro' }],
    'rejectedHunks survive the storage-compaction path too');

  // The aggressive fallback announces itself exactly when it engages. The
  // engage condition depends on internal byte limits that historical-run
  // compaction makes hard to exceed from a black-box fixture, so the wiring
  // is pinned at the source level: the callback fires inside the
  // over-target branch, before recursing with aggressive limits, and the
  // recursion preserves the caller's options.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'shared', 'sessionState.js'), 'utf8');
  const fnStart = source.indexOf('function prepareStateForStorage');
  const fnBody = source.slice(fnStart, source.indexOf('\n  }', fnStart));
  assert.match(fnBody, /if \(!options\.aggressive && estimateJsonBytes\(compact\) > limits\.targetBytes\) \{[\s\S]*options\.onAggressive[\s\S]*prepareStateForStorage\(input, \{ \.\.\.options, aggressive: true \}\)/,
    'onAggressive fires inside the over-target branch and options survive the aggressive recursion');

  // A normal-sized state must NOT fire the callback.
  let aggressiveNotices = 0;
  prepareStateForStorage(state, { onAggressive: () => { aggressiveNotices += 1; } });
  assert.equal(aggressiveNotices, 0, 'normal-sized state does not report aggressive compaction');
});

test('composer attachments persist across refresh within hard caps (v1.8.0 C4)', () => {
  const small = { id: 'a1', name: 'shot.png', mimeType: 'image/png', size: 10, kind: 'image', previewDataUrl: 'data:image/png;base64,AA', contentBase64: 'QUJD', dedupeKey: 'shot.png:10' };
  const oversized = { ...small, id: 'a2', name: 'big.pdf', kind: 'file', contentBase64: 'x'.repeat(1024 * 1024 + 1) };
  const state = normalizePanelState({
    activeSessionId: 'session_a',
    sessions: [{ id: 'session_a', title: 'A', runs: [] }],
    composerAttachments: [small, oversized, small, small, small]
  });
  // Oversized dropped; count capped at 3.
  assert.equal(state.composerAttachments.length, 3);
  assert.equal(state.composerAttachments.every(item => item.name === 'shot.png'), true);
  assert.equal(state.composerAttachments[0].contentBase64, 'QUJD');

  const compact = prepareStateForStorage(state);
  assert.equal(compact.composerAttachments.length, 3,
    'attachments survive the storage-compaction whitelist');
  assert.equal(compact.composerAttachments[0].contentBase64, 'QUJD');
});
