'use strict';

// Shared by project turns and broker workers. Skill-install turns run outside
// the project mirror and retain their existing installer command policy.
function formatOverleafWorkspaceRules() {
  return [
    'Overleaf workspace rules (also apply to delegated subagents):',
    '- This directory is a synchronized Overleaf project mirror without .git metadata.',
    '- Do not run Git commands in this mirror, including git status, git diff, git rev-parse, or git init. Do not create .git metadata or search parent directories for a repository.',
    '- Verify changes through direct file reads and searches. Run compilation checks only when needed and permitted by the current task and mode; never compile solely to replace an unavailable Git check.',
    '- The plugin compares the workspace against its synchronized baseline, collects file changes, and handles writeback to Overleaf. No Git-based diff, staging, or commit is required.',
    '- Include these workspace rules in every delegated subagent task so workers follow the same constraints.'
  ].join('\n');
}

module.exports = { formatOverleafWorkspaceRules };
