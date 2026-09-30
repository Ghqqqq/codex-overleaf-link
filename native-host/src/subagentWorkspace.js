'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SUBAGENT_QUEUE_DIR } = require('./mirrorWorkspace');
const { safeWorkspaceRelativePath } = require('./subagentWorkspacePath');
const { formatOverleafWorkspaceRules } = require('./overleafWorkspaceRules');

// Filesystem evidence and worker context are separate from scheduling policy.
function createSubagentWorkspace({ workspacePath, logsDir }) {
  function atomicWrite(target, text) {
    const tmp = path.join(path.dirname(target), `.tmp-${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  }

  function appendLog(jobId, text) {
    try {
      fs.appendFileSync(path.join(logsDir, `${jobId}.log`), `${new Date().toISOString()} ${text}\n`);
    } catch (_error) { /* logs are best-effort */ }
  }

  function adoptionHash(file) {
    try {
      const safe = safeWorkspaceRelativePath(file);
      if (!safe) return '';
      const absolute = path.join(workspacePath, safe);
      const stat = fs.lstatSync(absolute);
      const relative = path.relative(fs.realpathSync(workspacePath), fs.realpathSync(absolute));
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || path.isAbsolute(relative)
        || relative === '..' || relative.startsWith('..' + path.sep)) return '';
      return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    } catch (_error) { return ''; }
  }

  function hashWorkspace() {
    const hashes = new Map();
    walk(workspacePath, '');
    return hashes;

    function walk(dir, prefix) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_error) {
        return;
      }
      for (const entry of entries) {
        // The whole queue zone (incl. the work/ slice scratch) stays out of
        // wave hashing: scratch can never reach Overleaf, same-wave slices
        // are all in the owned union anyway, and a lead staggering slice
        // creation mid-wave must not read as a violation (v1.6.1).
        if (entry.name === '.DS_Store' || entry.name === SUBAGENT_QUEUE_DIR || entry.name === '.codex-overleaf-attachments') {
          continue;
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(absolute, relative);
        } else if (entry.isFile()) {
          hashes.set(relative, hashFile(absolute));
        }
      }
    }
  }

  function hashPaths(files) {
    const hashes = new Map();
    for (const file of files) {
      hashes.set(file, hashFile(path.join(workspacePath, file)));
    }
    return hashes;
  }

  function hashFile(absolute) {
    try {
      return crypto.createHash('sha1').update(fs.readFileSync(absolute)).digest('hex');
    } catch (_error) {
      return 'missing';
    }
  }

  function buildWorkerPrompt(job) {
    const readOnly = job.readOnlyContext.length
      ? `- You may read these for context but must not modify them: ${job.readOnlyContext.join(', ')}.\n`
      : '';
    return [
      'You are a subagent working on one slice of a larger task.',
      formatOverleafWorkspaceRules(),
      'HARD CONSTRAINTS:',
      `- You may modify ONLY these files: ${job.files.join(', ')}.`,
      readOnly + '- Do not modify, create, or delete any other file. Inside .codex-overleaf-subagents/ you may touch ONLY the slice files listed above (if any).',
      '- Work fully autonomously; nobody can answer questions.',
      '',
      job.task
    ].join('\n');
  }


  return { atomicWrite, appendLog, adoptionHash, hashWorkspace, hashPaths, hashFile, buildWorkerPrompt };
}
module.exports = { createSubagentWorkspace };
