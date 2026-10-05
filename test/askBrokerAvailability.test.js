'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { runCodexSession } = require('../native-host/src/codexSessionRunner');
const { getProjectMirror } = require('../native-host/src/mirrorWorkspace');
for (const mode of ['ask', 'auto']) test('file broker availability follows the existing ' + mode + ' sandbox', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-availability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rootDir = path.join(root, 'mirrors');
  const queue = path.join(getProjectMirror('project', { rootDir }).workspacePath, '.codex-overleaf-subagents');
  fs.mkdirSync(queue, { recursive: true }); fs.writeFileSync(path.join(queue, 'broker.json'), '{"status":"ready"}');
  let entered = false;
  const result = await runCodexSession({ rootDir, env: { HOME: root, USERPROFILE: root },
    params: { projectId: 'project', task: 'Synthetic test', mode, loadCodexLocalSkills: false,
      enabledCodexOverleafSkillIds: ['parallel-subagents'], project: { files: [{ path: 'main.tex', content: 'Original' }] } },
    executeCodex: async input => {
      entered = true;
      assert.equal(input.sandboxMode, mode === 'ask' ? 'read-only' : 'workspace-write');
      assert.equal(input.approvalPolicy, 'never');
      assert.equal(fs.existsSync(path.join(queue, 'broker.json')), mode === 'auto');
      if (mode === 'auto') assert.equal(JSON.parse(fs.readFileSync(path.join(queue, 'broker.json'))).status, 'ready');
      return { assistantMessage: 'Ordinary run remains available' };
    }
  });
  assert.equal(entered, true); assert.equal(result.assistantMessage, 'Ordinary run remains available');
});

test('broker worker receives the captured enabled skill IDs and keeps its recursion exclusion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-skill-inheritance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const enabled = ['parallel-subagents', 'synthetic-enabled'];
  let workerInput, parentInput, arrived;
  const workerStarted = new Promise(resolve => { arrived = resolve; });
  await runCodexSession({ rootDir: path.join(root, 'mirrors'), env: { HOME: root, USERPROFILE: root },
    params: { projectId: 'project', task: 'Synthetic parent', mode: 'auto', loadCodexLocalSkills: false,
      enabledCodexOverleafSkillIds: enabled, project: { files: [{ path: 'main.tex', content: 'Original' }] } },
    executeCodex: async input => {
      if (input.userTask.startsWith('subagent:')) { workerInput = input; arrived(); return { assistantMessage: 'Worker done' }; }
      parentInput = input;
      fs.writeFileSync(path.join(input.workspacePath, '.codex-overleaf-subagents/jobs/probe.json'), JSON.stringify({ id: 'probe', task: 'Read main.tex', files: ['main.tex'] }));
      let timer;
      try { await Promise.race([workerStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker did not start')), 2500); })]); }
      finally { clearTimeout(timer); }
      return { assistantMessage: 'Parent done' };
    }
  });
  assert.deepEqual(parentInput.enabledCodexOverleafSkillIds, enabled);
  assert.deepEqual(workerInput.enabledCodexOverleafSkillIds, enabled);
  assert.deepEqual(workerInput.disableCodexOverleafSkillIds, ['parallel-subagents']);
});
