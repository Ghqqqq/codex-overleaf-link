#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  if (process.env.FAKE_AGY_VERSION_DELAY_MS) {
    setTimeout(() => {
      process.stdout.write('agy 1.5.18\n');
      process.exit(0);
    }, Number(process.env.FAKE_AGY_VERSION_DELAY_MS));
  } else {
    process.stdout.write('agy 1.5.18\n');
    process.exit(0);
  }
  return;
}

if (argv[0] !== 'acp') {
  process.stderr.write(`Unexpected subcommand: ${argv.join(' ')}\n`);
  process.exit(2);
}
if (argv.includes('--app-data-dir')) {
  process.stderr.write('--app-data-dir must not be passed\n');
  process.exit(2);
}
const geminiDirIdx = argv.indexOf('--gemini-dir');
const geminiDir = geminiDirIdx >= 0 ? argv[geminiDirIdx + 1] : '';
if (!geminiDir || !path.isAbsolute(geminiDir)) {
  process.stderr.write('Expected absolute --gemini-dir\n');
  process.exit(2);
}

const stateFile = process.env.FAKE_AGY_STATE_FILE || '';
function readState() {
  if (!stateFile || !fs.existsSync(stateFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_error) {
    return {};
  }
}
function mutateState(mutator) {
  if (!stateFile) return;
  const current = readState();
  const next = mutator(current) || current;
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), 'utf8');
}

mutateState(state => {
  state.invocations = Array.isArray(state.invocations) ? state.invocations : [];
  state.invocations.push({
    pid: process.pid,
    argv,
    geminiDir,
    cwd: process.cwd()
  });
  state.lastPid = process.pid;
  return state;
});

const scenario = process.env.FAKE_AGY_SCENARIO || 'default';
let signedIn = scenario !== 'signed_out';
let authenticatedThisProcess = false;
let currentModel = process.env.FAKE_AGY_INITIAL_MODEL || 'gemini-4-neon';
let currentThoughtLevel = 'high';
let currentMode = 'auto'; // Intentionally non-default initially so tests prove Native sets `default` explicitly!
let activePrompt = null;
const pendingPermissions = new Map();
const sessionPromptCounts = new Map();
let nextServerReqId = 1000;

function thoughtOptionsForModel(modelId) {
  if (modelId === 'gemini-3.8-flash' || modelId === 'gemini-4-carbon') {
    return [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' }
    ];
  }
  return [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
    { value: 'xhigh', name: 'Extra High' }
  ];
}

function buildConfigOptions() {
  const thoughts = thoughtOptionsForModel(currentModel);
  if (!thoughts.some(item => item.value === currentThoughtLevel)) {
    currentThoughtLevel = 'high';
  }
  return [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'gemini-4-orchestrator', name: 'Gemini Orchestrator' },
        { value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
        { value: 'gpt-oss-120b', name: 'GPT OSS 120B' }
      ]
    },
    {
      id: 'thought_level',
      category: 'thought_level',
      type: 'select',
      currentValue: currentThoughtLevel,
      options: thoughts
    },
    {
      id: 'mode',
      category: 'mode',
      type: 'select',
      currentValue: currentMode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept Edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' }
      ]
    }
  ];
}

function buildAvailableModels() {
  return [
    { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
    { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (Extra High)' },
    { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
    { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
    { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
    { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { modelId: 'gemini-4-orchestrator-high', name: 'Gemini Orchestrator' },
    { modelId: 'claude-sonnet-4-5-high', name: 'Claude Sonnet 4.5' },
    { modelId: 'gpt-oss-120b-medium', name: 'GPT OSS 120B' }
  ];
}

function send(payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
}

function sendUpdate(sessionId, update) {
  send({
    method: 'session/update',
    params: { sessionId, update }
  });
}

function requestPermission(sessionId, toolCall) {
  const id = nextServerReqId++;
  send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject-1', kind: 'reject_once', name: 'Reject once' }
      ]
    }
  });
  return new Promise(resolve => {
    pendingPermissions.set(id, resolve);
  });
}

function isApprovedOutcome(result) {
  return result?.outcome?.outcome === 'selected' && result.outcome.optionId === 'allow-1';
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  const cwd = process.cwd();
  const promptIndex = sessionPromptCounts.get(sessionId) || 0;
  sessionPromptCounts.set(sessionId, promptIndex + 1);
  mutateState(state => {
    state.prompts = Array.isArray(state.prompts) ? state.prompts : [];
    state.prompts.push({ sessionId, prompt: params.prompt });
    return state;
  });

  if (process.env.FAKE_AGY_STDERR_EXIT) {
    process.stderr.write(`${process.env.FAKE_AGY_STDERR_EXIT}\n`);
    process.exit(1);
  }
  if (process.env.FAKE_AGY_PROMPT_RPC_ERROR_JSON) {
    const spec = JSON.parse(process.env.FAKE_AGY_PROMPT_RPC_ERROR_JSON);
    if (spec.nullIdFrame) {
      send({ id: null, error: spec.error });
    } else {
      send({ id, error: spec.error });
    }
    return;
  }

  let cancelled = false;
  let onCancel = null;
  activePrompt = {
    sessionId,
    cancel() {
      cancelled = true;
      onCancel?.();
    }
  };

  if (scenario === 'hang_until_cancel') {
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Working before cancel...' }
    });
    const permPromise = requestPermission(sessionId, {
      toolCallId: 'call-hang',
      kind: 'execute',
      title: 'Long check',
      rawInput: { CommandLine: 'rg section main.tex' }
    });
    await new Promise(resolve => {
      onCancel = resolve;
      void permPromise.then(() => {
        if (cancelled) resolve();
      });
    });
    activePrompt = null;
    send({ id, result: { stopReason: 'cancelled' } });
    return;
  }

  if (scenario === 'reject_then_continue') {
    const blockCycles = Number(process.env.FAKE_AGY_BLOCK_CYCLES || '1');
    const hangOnCycle = process.env.FAKE_AGY_HANG_ON_CYCLE !== undefined
      ? Number(process.env.FAKE_AGY_HANG_ON_CYCLE)
      : -1;
    const outsideTarget = process.env.FAKE_AGY_OUTSIDE_TARGET || path.resolve(cwd, '..', 'outside-blocked.txt');

    if (promptIndex === hangOnCycle) {
      await requestPermission(sessionId, {
        toolCallId: `hang-block-${promptIndex}`,
        kind: 'execute',
        title: 'Blocked command before cancel',
        rawInput: { CommandLine: 'rm -f main.tex' }
      });
      await new Promise(resolve => {
        if (cancelled) {
          resolve();
          return;
        }
        onCancel = resolve;
      });
      activePrompt = null;
      send({ id, result: { stopReason: 'cancelled' } });
      return;
    }

    if (promptIndex < blockCycles) {
      if (promptIndex === 0 && process.env.FAKE_AGY_PREAMBLE_TEXT) {
        sendUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: process.env.FAKE_AGY_PREAMBLE_TEXT }
        });
      }
      const blockedTool = promptIndex === 0
        ? {
            toolCallId: `blocked-${promptIndex}`,
            kind: 'execute',
            title: 'Find with pipe',
            rawInput: { CommandLine: 'find . -maxdepth 1 | head' }
          }
        : promptIndex === 1
          ? {
              toolCallId: `blocked-${promptIndex}`,
              kind: 'execute',
              title: 'Python script',
              rawInput: { CommandLine: 'python3 inspect.py' }
            }
          : {
              toolCallId: `blocked-${promptIndex}`,
              kind: 'read',
              title: 'Outside read',
              locations: [{ path: outsideTarget }],
              rawInput: { Path: outsideTarget }
            };
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        ...blockedTool,
        status: 'pending'
      });
      await requestPermission(sessionId, blockedTool);
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: blockedTool.toolCallId,
        status: 'failed'
      });
      activePrompt = null;
      send({
        id,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 300 + promptIndex * 100, outputTokens: 10, totalTokens: 310 + promptIndex * 100 }
        }
      });
      return;
    }

    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Recovered answer after continuation.' }
    });
    activePrompt = null;
    send({
      id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 600, outputTokens: 40, totalTokens: 640 }
      }
    });
    return;
  }

  if (scenario === 'edit_and_boundary') {
    if (promptIndex > 0) {
      activePrompt = null;
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    const insideTarget = path.join(cwd, 'main.tex');
    const outsideTarget = process.env.FAKE_AGY_OUTSIDE_TARGET || path.resolve(cwd, '..', 'outside-escape.txt');
    const attachmentTarget = path.join(cwd, '.codex-overleaf-attachments', 'secret.txt');

    sendUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking mirror permissions.' }
    });

    // 1. In-mirror edit
    sendUpdate(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-inside',
      kind: 'edit',
      title: 'Edit main.tex',
      status: 'pending',
      locations: [{ path: insideTarget }],
      content: [{ type: 'diff', path: insideTarget, oldText: 'Old body', newText: 'Updated by Antigravity' }]
    });
    const insideDecision = await requestPermission(sessionId, {
      toolCallId: 'edit-inside',
      kind: 'edit',
      title: 'Edit main.tex',
      locations: [{ path: insideTarget }],
      rawInput: { Path: insideTarget }
    });
    const insideAllowed = isApprovedOutcome(insideDecision);
    if (insideAllowed) {
      fs.writeFileSync(insideTarget, '\\documentclass{article}\n\\begin{document}\nUpdated by Antigravity.\n\\end{document}\n', 'utf8');
    }
    sendUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-inside',
      status: insideAllowed ? 'completed' : 'failed'
    });

    // 2. Outside-mirror edit attempt
    sendUpdate(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-outside',
      kind: 'edit',
      title: 'Edit outside file',
      status: 'pending',
      locations: [{ path: outsideTarget }]
    });
    const outsideDecision = await requestPermission(sessionId, {
      toolCallId: 'edit-outside',
      kind: 'edit',
      title: 'Edit outside file',
      locations: [{ path: outsideTarget }],
      rawInput: { Path: outsideTarget }
    });
    const outsideAllowed = isApprovedOutcome(outsideDecision);
    if (outsideAllowed) {
      fs.writeFileSync(outsideTarget, 'ESCAPED\n', 'utf8');
    }
    sendUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-outside',
      status: outsideAllowed ? 'completed' : 'failed'
    });

    // 3. Reserved .codex-overleaf-attachments edit attempt
    const reservedDecision = await requestPermission(sessionId, {
      toolCallId: 'edit-reserved',
      kind: 'edit',
      title: 'Edit attachment dir',
      locations: [{ path: attachmentTarget }],
      rawInput: { Path: attachmentTarget }
    });
    const reservedAllowed = isApprovedOutcome(reservedDecision);
    if (reservedAllowed) {
      fs.mkdirSync(path.dirname(attachmentTarget), { recursive: true });
      fs.writeFileSync(attachmentTarget, 'OVERWRITTEN\n', 'utf8');
    }

    mutateState(state => {
      state.permissionResults = { insideAllowed, outsideAllowed, reservedAllowed };
      return state;
    });

    sendUpdate(sessionId, {
      sessionUpdate: 'usage_update',
      used: 3456,
      size: 1048576
    });
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: insideAllowed ? 'Applied update to main.tex:3.' : 'Read-only inspection completed for main.tex:1.'
      }
    });
    activePrompt = null;
    send({
      id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 3200, outputTokens: 256, totalTokens: 3456 }
      }
    });
    return;
  }

  if (scenario === 'permission_matrix') {
    if (promptIndex > 0) {
      activePrompt = null;
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    const outsideReadPath = process.env.FAKE_AGY_OUTSIDE_TARGET || path.resolve(cwd, '..', 'outside-secret.txt');
    const insideReadPath = path.join(cwd, 'main.tex');
    const checks = [
      ['rg_cmd', { toolCallId: 'c1', kind: 'execute', title: 'rg', rawInput: { CommandLine: 'rg -n document main.tex' } }],
      ['find_safe_cmd', { toolCallId: 'c1a', kind: 'execute', title: 'find safe', rawInput: { CommandLine: "find . -maxdepth 3 -not -path '*/.*'" } }],
      ['find_name_cmd', { toolCallId: 'c1b', kind: 'execute', title: 'find name', rawInput: { CommandLine: "find . -name '*.tex'" } }],
      ['find_exec_cmd', { toolCallId: 'c1c', kind: 'execute', title: 'find exec', rawInput: { CommandLine: "find . -name '*.tex' -exec cat {} +" } }],
      ['find_execdir_cmd', { toolCallId: 'c1d', kind: 'execute', title: 'find execdir', rawInput: { CommandLine: 'find . -execdir cat {} +' } }],
      ['find_ok_cmd', { toolCallId: 'c1e', kind: 'execute', title: 'find ok', rawInput: { CommandLine: 'find . -ok cat {} +' } }],
      ['find_okdir_cmd', { toolCallId: 'c1f', kind: 'execute', title: 'find okdir', rawInput: { CommandLine: 'find . -okdir cat {} +' } }],
      ['find_delete_cmd', { toolCallId: 'c1g', kind: 'execute', title: 'find delete', rawInput: { CommandLine: "find . -name '*.aux' -delete" } }],
      ['find_fprint_cmd', { toolCallId: 'c1h', kind: 'execute', title: 'find fprint', rawInput: { CommandLine: 'find . -fprint out.txt' } }],
      ['find_fprint0_cmd', { toolCallId: 'c1i', kind: 'execute', title: 'find fprint0', rawInput: { CommandLine: 'find . -fprint0 out.txt' } }],
      ['find_fprintf_cmd', { toolCallId: 'c1j', kind: 'execute', title: 'find fprintf', rawInput: { CommandLine: 'find . -fprintf out.txt %p' } }],
      ['find_fls_cmd', { toolCallId: 'c1k', kind: 'execute', title: 'find fls', rawInput: { CommandLine: 'find . -fls out.txt' } }],
      ['find_outside_cmd', { toolCallId: 'c1l', kind: 'execute', title: 'find outside', rawInput: { CommandLine: `find "${outsideReadPath}" -maxdepth 1` } }],
      ['latexmk_cmd', { toolCallId: 'c2', kind: 'execute', title: 'latexmk', rawInput: { CommandLine: 'latexmk -norc -pdf main.tex' } }],
      ['redirect_cmd', { toolCallId: 'c3', kind: 'execute', title: 'redirect', rawInput: { CommandLine: 'cat main.tex > hacked.tex' } }],
      ['rm_cmd', { toolCallId: 'c4', kind: 'execute', title: 'rm', rawInput: { CommandLine: 'rm -f main.tex' } }],
      ['background_chain_cmd', { toolCallId: 'c4b', kind: 'execute', title: 'chain', rawInput: { CommandLine: 'cat main.tex & rm -f main.tex' } }],
      ['newline_chain_cmd', { toolCallId: 'c4c', kind: 'execute', title: 'chain', rawInput: { CommandLine: 'cat main.tex\nrm -f main.tex' } }],
      ['output_file_cmd', { toolCallId: 'c4d', kind: 'execute', title: 'uniq', rawInput: { CommandLine: 'uniq main.tex copied.tex' } }],
      ['path_executable_cmd', { toolCallId: 'c4e', kind: 'execute', title: 'path rg', rawInput: { CommandLine: './rg document main.tex' } }],
      ['outside_path_cmd', { toolCallId: 'c4f', kind: 'execute', title: 'cat outside', rawInput: { CommandLine: `cat ${outsideReadPath}` } }],
      ['read_inside', { toolCallId: 'c5', kind: 'read', title: 'read inside', locations: [{ path: insideReadPath }], rawInput: { Path: insideReadPath } }],
      ['read_outside', { toolCallId: 'c6', kind: 'read', title: 'read outside', locations: [{ path: outsideReadPath }], rawInput: { Path: outsideReadPath } }],
      ['fetch_unknown', { toolCallId: 'c7', kind: 'fetch', title: 'fetch url', rawInput: { url: 'https://example.com' } }],
      ['mcp_unknown', { toolCallId: 'c8', kind: 'mcp', title: 'mcp call', rawInput: { server: 'test' } }]
    ];
    const outcomes = {};
    for (const [name, toolCall] of checks) {
      const reply = await requestPermission(sessionId, toolCall);
      outcomes[name] = isApprovedOutcome(reply);
    }
    mutateState(state => {
      state.matrix = state.matrix || [];
      state.matrix.push(outcomes);
      return state;
    });
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Completed permission matrix.' }
    });
    activePrompt = null;
    send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } });
    return;
  }

  if (scenario === 'interleaved_and_declined') {
    if (promptIndex > 0) {
      activePrompt = null;
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    const outsideTarget = process.env.FAKE_AGY_OUTSIDE_TARGET || path.resolve(cwd, '..', 'outside-declined.txt');
    const styleSkillFile = process.env.FAKE_AGY_STYLE_SKILL_FILE || '';
    const styleOutcomes = {};

    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-interleaved',
      content: { type: 'text', text: 'Prefix before tools; ' }
    });
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking between chunks of m-interleaved.' }
    });

    // Declined write followed by a lying `completed` tool_call_update: Native must keep it `declined`.
    sendUpdate(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'declined-write-1',
      kind: 'edit',
      title: 'Attempt outside write',
      status: 'pending',
      locations: [{ path: outsideTarget }]
    });
    const declinedWrite = await requestPermission(sessionId, {
      toolCallId: 'declined-write-1',
      kind: 'edit',
      title: 'Attempt outside write',
      locations: [{ path: outsideTarget }],
      rawInput: { Path: outsideTarget }
    });
    styleOutcomes.declinedWriteAllowed = isApprovedOutcome(declinedWrite);
    sendUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'declined-write-1',
      status: 'completed',
      content: [{ type: 'diff', path: outsideTarget, oldText: null, newText: 'bogus' }]
    });

    // Declined execute and read tools must also emit status: 'declined'.
    const declinedExec = await requestPermission(sessionId, {
      toolCallId: 'declined-exec-1',
      kind: 'execute',
      title: 'Attempt rm',
      rawInput: { CommandLine: 'rm -f main.tex' }
    });
    styleOutcomes.declinedExecAllowed = isApprovedOutcome(declinedExec);

    const declinedFetch = await requestPermission(sessionId, {
      toolCallId: 'declined-fetch-1',
      kind: 'fetch',
      title: 'Attempt fetch',
      rawInput: { url: 'https://example.com' }
    });
    styleOutcomes.declinedFetchAllowed = isApprovedOutcome(declinedFetch);

    if (styleSkillFile) {
      const styleDir = path.dirname(styleSkillFile);
      styleOutcomes.styleReadAllowed = isApprovedOutcome(await requestPermission(sessionId, {
        toolCallId: 'style-read-1',
        kind: 'read',
        title: 'Read writing style SKILL.md',
        locations: [{ path: styleSkillFile }],
        rawInput: { Path: styleSkillFile }
      }));
      styleOutcomes.styleCatAllowed = isApprovedOutcome(await requestPermission(sessionId, {
        toolCallId: 'style-cat-1',
        kind: 'execute',
        title: 'Cat writing style SKILL.md',
        rawInput: { CommandLine: `cat "${styleSkillFile}"` }
      }));
      styleOutcomes.styleEditAllowed = isApprovedOutcome(await requestPermission(sessionId, {
        toolCallId: 'style-edit-1',
        kind: 'edit',
        title: 'Edit writing style SKILL.md',
        locations: [{ path: styleSkillFile }],
        rawInput: { Path: styleSkillFile }
      }));
      styleOutcomes.styleCwdAllowed = isApprovedOutcome(await requestPermission(sessionId, {
        toolCallId: 'style-cwd-1',
        kind: 'read',
        title: 'Read with style dir as cwd',
        rawInput: { Path: path.join(cwd, 'main.tex'), cwd: styleDir }
      }));
    }

    if (process.env.FAKE_AGY_FLOOD_BYTES) {
      const total = Number(process.env.FAKE_AGY_FLOOD_BYTES) || 0;
      const chunk = 'x'.repeat(65536);
      for (let sent = 0; sent < total; sent += chunk.length) {
        sendUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm-flood',
          content: { type: 'text', text: chunk }
        });
      }
    } else {
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm-interleaved',
        content: { type: 'text', text: 'suffix after tools.' }
      });
    }

    mutateState(state => {
      state.interleavedOutcomes = styleOutcomes;
      return state;
    });

    activePrompt = null;
    send({
      id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 }
      }
    });
    return;
  }

  // Default simple turn
  sendUpdate(sessionId, {
    sessionUpdate: 'usage_update',
    used: 1024,
    size: 1048576
  });
  sendUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello from fake Antigravity.' }
  });
  activePrompt = null;
  send({
    id,
    result: {
      stopReason: 'end_turn',
      usage: { inputTokens: 900, outputTokens: 124, totalTokens: 1024 }
    }
  });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    if (msg.id !== undefined && !msg.method && pendingPermissions.has(msg.id)) {
      const resolver = pendingPermissions.get(msg.id);
      pendingPermissions.delete(msg.id);
      resolver(msg.result);
      continue;
    }
    if (msg.method === 'session/cancel') {
      mutateState(state => {
        state.cancels = Array.isArray(state.cancels) ? state.cancels : [];
        state.cancels.push(msg.params);
        return state;
      });
      activePrompt?.cancel();
      continue;
    }
    if (msg.method === 'initialize') {
      const omitVersion = process.env.FAKE_AGY_OMIT_INIT_VERSION === '1';
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: omitVersion ? { name: 'antigravity' } : { name: 'antigravity', version: '1.5.18' },
          agentCapabilities: {
            sessionCapabilities: { resume: {}, load: {}, close: {}, list: {} },
            promptCapabilities: { image: true }
          },
          authMethods: [{ id: 'oauth-personal', name: 'Google' }]
        }
      });
      continue;
    }
    if (msg.method === 'authenticate') {
      mutateState(state => {
        state.authenticates = Array.isArray(state.authenticates) ? state.authenticates : [];
        state.authenticates.push(msg.params);
        return state;
      });
      if (process.env.FAKE_AGY_LOGIN_FAIL === '1') {
        send({
          id: msg.id,
          error: {
            code: -32000,
            message: 'Authentication required',
            data: { authMethods: [{ id: 'oauth-personal', name: 'Google' }] }
          }
        });
      } else {
        signedIn = true;
        authenticatedThisProcess = true;
        mutateState(state => {
          state.signedIn = true;
          return state;
        });
        send({
          id: msg.id,
          result: {
            _meta: { antigravity: { tier: { name: 'Google AI Ultra', id: 'g1-ultra-tier' } } }
          }
        });
      }
      continue;
    }
    if (msg.method === 'session/new') {
      if (authenticatedThisProcess && process.env.FAKE_AGY_POST_AUTH_PROBE_HANG === '1') {
        continue;
      }
      const persistedSignedIn = signedIn || readState().signedIn === true;
      if (!persistedSignedIn) {
        send({
          id: msg.id,
          error: {
            code: -32000,
            message: 'Authentication required',
            data: { authMethods: [{ id: 'oauth-personal', name: 'Google' }] }
          }
        });
        continue;
      }
      const respondNewSession = () => {
        const sessionId = `sess-${(readState().sessionCounter || 0) + 1}`;
        mutateState(state => {
          state.sessionCounter = (state.sessionCounter || 0) + 1;
          state.sessionsCreated = Array.isArray(state.sessionsCreated) ? state.sessionsCreated : [];
          state.sessionsCreated.push({ sessionId, cwd: msg.params?.cwd });
          return state;
        });
        send({
          id: msg.id,
          result: {
            sessionId,
            models: {
              currentModelId: `${currentModel}-${currentThoughtLevel}`,
              availableModels: buildAvailableModels()
            },
            configOptions: buildConfigOptions(),
            _meta: { antigravity: { tier: { name: 'Google AI Ultra', id: 'g1-ultra-tier' } } }
          }
        });
      };
      const delayMs = Number(process.env.FAKE_AGY_SETUP_DELAY_MS) || 0;
      if (delayMs > 0) {
        setTimeout(respondNewSession, delayMs);
      } else {
        respondNewSession();
      }
      continue;
    }
    if (msg.method === 'session/resume') {
      const persistedSignedIn = signedIn || readState().signedIn === true;
      if (!persistedSignedIn) {
        send({
          id: msg.id,
          error: {
            code: -32000,
            message: 'Authentication required',
            data: { authMethods: [{ id: 'oauth-personal', name: 'Google' }] }
          }
        });
        continue;
      }
      const sessionId = String(msg.params?.sessionId || '');
      if (sessionId === 'missing-session') {
        send({ id: msg.id, error: { code: -32002, message: 'Session not found' } });
        continue;
      }
      mutateState(state => {
        state.sessionsResumed = Array.isArray(state.sessionsResumed) ? state.sessionsResumed : [];
        state.sessionsResumed.push({ sessionId, cwd: msg.params?.cwd });
        return state;
      });
      send({
        id: msg.id,
        result: {
          sessionId,
          configOptions: buildConfigOptions()
        }
      });
      continue;
    }
    if (msg.method === 'session/close') {
      mutateState(state => {
        state.sessionsClosed = Array.isArray(state.sessionsClosed) ? state.sessionsClosed : [];
        state.sessionsClosed.push({ sessionId: msg.params?.sessionId });
        return state;
      });
      send({ id: msg.id, result: {} });
      continue;
    }
    if (msg.method === 'session/set_config_option') {
      const { configId, value } = msg.params || {};
      if (configId === 'model' && process.env.FAKE_AGY_IGNORE_MODEL_SET !== '1') currentModel = value;
      if (configId === 'thought_level') currentThoughtLevel = value;
      if (configId === 'mode' && process.env.FAKE_AGY_IGNORE_MODE_SET !== '1') currentMode = value;
      mutateState(state => {
        state.configUpdates = Array.isArray(state.configUpdates) ? state.configUpdates : [];
        state.configUpdates.push({ sessionId: msg.params?.sessionId, configId, value });
        return state;
      });
      send({
        id: msg.id,
        result: { configOptions: buildConfigOptions() }
      });
      continue;
    }
    if (msg.method === 'session/prompt') {
      void handlePrompt(msg.id, msg.params || {});
      continue;
    }
    if (msg.id !== undefined) {
      send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
    }
  }
});
