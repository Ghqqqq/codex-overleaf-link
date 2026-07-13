const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCodexHomeEnv,
  clearPluginCodexHistory,
  ensureDefaultCodexOverleafSkills,
  getPluginCodexHome,
  getUserCodexHome,
  preparePluginCodexHome
} = require('../native-host/src/codexHome');

test('Codex homes fall back to USERPROFILE when HOME is absent', () => {
  const userProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-userprofile-'));
  try {
    assert.equal(getUserCodexHome({ USERPROFILE: userProfile }), path.join(userProfile, '.codex'));
    assert.equal(
      getPluginCodexHome({ USERPROFILE: userProfile }),
      path.join(userProfile, '.codex-overleaf', 'codex-home')
    );
  } finally {
    fs.rmSync(userProfile, { recursive: true, force: true });
  }
});

test('Windows Codex homes prefer USERPROFILE before HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-msys-home-'));
  const userProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-win-profile-'));
  try {
    const env = { HOME: home, USERPROFILE: userProfile };

    assert.equal(getUserCodexHome(env, { platform: 'win32' }), path.join(userProfile, '.codex'));
    assert.equal(
      getPluginCodexHome(env, { platform: 'win32' }),
      path.join(userProfile, '.codex-overleaf', 'codex-home')
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userProfile, { recursive: true, force: true });
  }
});

test('plugin Codex home mirrors auth/config but does not copy global sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-home-'));
  const userCodexHome = path.join(home, '.codex');
  const userSessionFile = path.join(userCodexHome, 'sessions', '2026', '05', '02', 'session.jsonl');
  try {
    fs.mkdirSync(path.dirname(userSessionFile), { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"token":"user-token"}\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
    fs.writeFileSync(userSessionFile, '{"global":true}\n', 'utf8');

    const prepared = preparePluginCodexHome({ HOME: home });
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');

    assert.equal(prepared.pluginHome, pluginHome);
    assert.equal(prepared.userHome, userCodexHome);
    assert.equal(fs.readFileSync(path.join(pluginHome, 'auth.json'), 'utf8'), '{"token":"user-token"}\n');
    assert.equal(fs.readFileSync(path.join(pluginHome, 'config.toml'), 'utf8'), 'model = "gpt-5.5"\n');
    assert.equal(fs.existsSync(path.join(pluginHome, 'sessions')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home and copied auth use restrictive permissions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-home-'));
  const userCodexHome = path.join(home, '.codex');
  try {
    fs.mkdirSync(userCodexHome, { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"token":"user-token"}\n', 'utf8');

    const prepared = preparePluginCodexHome({ HOME: home });
    if (process.platform === 'win32') {
      assert.equal(fs.existsSync(prepared.pluginHome), true);
      assert.equal(fs.existsSync(path.join(prepared.pluginHome, 'auth.json')), true);
      return;
    }
    const pluginHomeMode = fs.statSync(prepared.pluginHome).mode & 0o777;
    const authMode = fs.statSync(path.join(prepared.pluginHome, 'auth.json')).mode & 0o777;

    assert.equal(pluginHomeMode, 0o700);
    assert.equal(authMode, 0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home reuses local Codex skills and plugin config without linking history', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-home-'));
  const userCodexHome = path.join(home, '.codex');
  try {
    fs.mkdirSync(path.join(userCodexHome, 'skills', 'user-skill'), { recursive: true });
    fs.mkdirSync(path.join(userCodexHome, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(userCodexHome, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(userCodexHome, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'skills', 'user-skill', 'SKILL.md'), '# User Skill\n', 'utf8');

    preparePluginCodexHome({ HOME: home });
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');

    assert.equal(fs.lstatSync(path.join(pluginHome, 'skills')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(pluginHome, 'skills', 'user-skill')).isSymbolicLink(), true);
    assert.equal(
      normalizeLinkTarget(fs.readlinkSync(path.join(pluginHome, 'skills', 'user-skill'))),
      path.join(userCodexHome, 'skills', 'user-skill')
    );
    assert.equal(fs.lstatSync(path.join(pluginHome, 'plugins')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(pluginHome, 'rules')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'sessions')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home composes user and Codex Overleaf skills according to load toggles', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-skill-compose-'));
  const userCodexHome = path.join(home, '.codex');
  const overleafSkillsRoot = path.join(home, '.codex-overleaf', 'skills');
  try {
    fs.mkdirSync(path.join(userCodexHome, 'skills', 'global-style'), { recursive: true });
    fs.mkdirSync(path.join(userCodexHome, 'superpowers', 'skills', 'brainstorming'), { recursive: true });
    fs.mkdirSync(path.join(userCodexHome, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(overleafSkillsRoot, 'overleaf-style'), { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'skills', 'global-style', 'SKILL.md'), '# Global Style\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'superpowers', 'skills', 'brainstorming', 'SKILL.md'), '# Brainstorming\n', 'utf8');
    fs.writeFileSync(path.join(overleafSkillsRoot, 'overleaf-style', 'SKILL.md'), '# Overleaf Style\n', 'utf8');

    preparePluginCodexHome({ HOME: home }, {
      loadCodexLocalSkills: true,
      loadCodexOverleafSkills: true
    });

    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
    assert.equal(fs.lstatSync(path.join(pluginHome, 'skills', 'global-style')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(pluginHome, 'skills', 'overleaf-style')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(pluginHome, 'superpowers')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(pluginHome, 'plugins')).isSymbolicLink(), true);
    fs.mkdirSync(path.join(pluginHome, '.tmp', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(pluginHome, '.tmp', 'plugins.sha'), 'old-plugin-cache', 'utf8');
    fs.writeFileSync(path.join(pluginHome, '.tmp', 'app-server-remote-plugin-sync-v1'), 'old-plugin-cache', 'utf8');
    fs.mkdirSync(path.join(pluginHome, 'cache', 'codex_apps_tools'), { recursive: true });

    preparePluginCodexHome({ HOME: home }, {
      loadCodexLocalSkills: false,
      loadCodexOverleafSkills: true
    });
    assert.equal(fs.existsSync(path.join(pluginHome, 'skills', 'global-style')), false);
    assert.equal(fs.lstatSync(path.join(pluginHome, 'skills', 'overleaf-style')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(pluginHome, 'superpowers')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'plugins')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, '.tmp', 'plugins')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, '.tmp', 'plugins.sha')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, '.tmp', 'app-server-remote-plugin-sync-v1')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'cache', 'codex_apps_tools')), false);

    preparePluginCodexHome({ HOME: home }, {
      loadCodexLocalSkills: false,
      loadCodexOverleafSkills: false
    });
    assert.equal(fs.existsSync(path.join(pluginHome, 'skills')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'superpowers')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'plugins')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home materializes project-local skills for automatic Codex triggering', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-project-skill-home-'));
  const mirrorRoot = path.join(home, 'mirrors');
  const projectRoot = path.join(mirrorRoot, 'project-auto-skills', 'workspace');
  try {
    fs.mkdirSync(path.join(projectRoot, '.codex-overleaf', 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.codex-overleaf', 'skills', 'paper-style.md'),
      '# Paper Style\n\nPrefer concise paper edits.\n',
      'utf8'
    );

    preparePluginCodexHome({ HOME: home }, {
      loadCodexLocalSkills: false,
      loadCodexOverleafSkills: false,
      projectLocalSkills: {
        projectId: 'project-auto-skills',
        projectRoot
      }
    });

    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
    const skillPath = path.join(pluginHome, 'skills', 'paper-style', 'SKILL.md');
    assert.equal(fs.lstatSync(skillPath).isFile(), true);
    assert.match(fs.readFileSync(skillPath, 'utf8'), /Prefer concise paper edits/);
    assert.equal(fs.existsSync(path.join(pluginHome, 'skills', 'global-style')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home strips local plugin config when Codex local skills are disabled', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-config-sanitize-'));
  const userCodexHome = path.join(home, '.codex');
  try {
    fs.mkdirSync(userCodexHome, { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'config.toml'), [
      'model = "gpt-5.5"',
      'notify = ["/Users/example/.codex/plugins/cache/notifier", "turn-ended"]',
      '',
      '[features]',
      'multi_agent = true',
      '',
      '[[skills.config]]',
      'name = "superpowers:brainstorming"',
      'enabled = true',
      '',
      '[plugins."github@openai-curated"]',
      'enabled = true',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '',
      '[projects."/tmp/workspace"]',
      'trust_level = "trusted"',
      '',
      '[marketplaces.openai-bundled]',
      'source = "/Users/example/.codex/.tmp/bundled-marketplaces/openai-bundled"',
      '',
      '[model_providers.openai_official]',
      'name = "OpenAI Official"'
    ].join('\n'), 'utf8');

    preparePluginCodexHome({ HOME: home }, {
      loadCodexLocalSkills: false,
      loadCodexOverleafSkills: true
    });
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
    const sanitizedConfig = fs.readFileSync(path.join(pluginHome, 'config.toml'), 'utf8');

    assert.match(sanitizedConfig, /model = "gpt-5\.5"/);
    assert.match(sanitizedConfig, /\[features\]/);
    assert.match(sanitizedConfig, /\[projects\."\/tmp\/workspace"\]/);
    assert.match(sanitizedConfig, /\[model_providers\.openai_official\]/);
    assert.doesNotMatch(sanitizedConfig, /notify =/);
    assert.doesNotMatch(sanitizedConfig, /\[\[skills\.config\]\]/);
    assert.doesNotMatch(sanitizedConfig, /\[plugins\./);
    assert.doesNotMatch(sanitizedConfig, /\[mcp_servers\./);
    assert.doesNotMatch(sanitizedConfig, /\[marketplaces\./);

    preparePluginCodexHome({ HOME: home }, {
      loadCodexLocalSkills: true,
      loadCodexOverleafSkills: true
    });
    const fullConfig = fs.readFileSync(path.join(pluginHome, 'config.toml'), 'utf8');
    assert.match(fullConfig, /\[plugins\."github@openai-curated"\]/);
    assert.match(fullConfig, /\[mcp_servers\.playwright\]/);
    assert.match(fullConfig, /\[marketplaces\.openai-bundled\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home can target persistent Codex Overleaf skills for installer turns', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-skill-install-home-'));
  const overleafSkillsRoot = path.join(home, '.codex-overleaf', 'skills');
  const env = { HOME: home, CODEX_OVERLEAF_SKILLS_ROOT: overleafSkillsRoot };
  try {
    preparePluginCodexHome(env, {
      installCodexOverleafSkillsTarget: true,
      getNativeHostPlatform: () => 'darwin'
    });

    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
    const pluginSkills = path.join(pluginHome, 'skills');
    assert.equal(fs.lstatSync(pluginSkills).isSymbolicLink(), true);
    assert.equal(normalizeLinkTarget(fs.readlinkSync(pluginSkills)), overleafSkillsRoot);
    assert.equal(fs.statSync(overleafSkillsRoot).isDirectory(), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function normalizeLinkTarget(target) {
  return String(target).replace(/[\\/]+$/, '');
}

test('plugin Codex home reports skipped links while preserving copied auth/config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-link-failure-'));
  const userCodexHome = path.join(home, '.codex');
  const originalSymlinkSync = fs.symlinkSync;
  try {
    fs.mkdirSync(path.join(userCodexHome, 'skills', 'user-skill'), { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"token":"user-token"}\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
    fs.symlinkSync = () => {
      const error = new Error('link denied');
      error.code = 'EPERM';
      throw error;
    };

    const prepared = preparePluginCodexHome({ HOME: home });
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');

    assert.equal(fs.readFileSync(path.join(pluginHome, 'auth.json'), 'utf8'), '{"token":"user-token"}\n');
    assert.equal(fs.readFileSync(path.join(pluginHome, 'config.toml'), 'utf8'), 'model = "gpt-5.5"\n');
    assert.deepEqual(prepared.linked, []);
    assert.deepEqual(prepared.skippedLinks.map(link => [link.name, link.reason]), [
      ['skills/user-skill', 'EPERM'],
      ['skills/annotated-rewrite', 'EPERM'],
      ['skills/parallel-subagents', 'EPERM']
    ]);
  } finally {
    fs.symlinkSync = originalSymlinkSync;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Windows plugin Codex directory links request junction semantics', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-junction-'));
  const userCodexHome = path.join(home, 'user-codex');
  const pluginHome = path.join(home, 'plugin-codex');
  const originalSymlinkSync = fs.symlinkSync;
  const calls = [];
  try {
    fs.mkdirSync(path.join(userCodexHome, 'skills', 'user-skill'), { recursive: true });
    fs.symlinkSync = (source, target, type) => {
      calls.push({ source, target, type });
    };

    const prepared = preparePluginCodexHome({
      HOME: home,
      CODEX_OVERLEAF_USER_CODEX_HOME: userCodexHome,
      CODEX_OVERLEAF_CODEX_HOME: pluginHome
    }, { platform: 'win32' });

    assert.deepEqual(prepared.linked, ['skills']);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].source, path.join(userCodexHome, 'skills', 'user-skill'));
    assert.equal(calls[0].target, path.join(pluginHome, 'skills', 'user-skill'));
    assert.equal(calls[0].type, 'junction');
    assert.equal(calls[1].target, path.join(pluginHome, 'skills', 'annotated-rewrite'));
    assert.equal(calls[1].type, 'junction');
    assert.equal(calls[2].target, path.join(pluginHome, 'skills', 'parallel-subagents'));
    assert.equal(calls[2].type, 'junction');
  } finally {
    fs.symlinkSync = originalSymlinkSync;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex app-server env uses plugin-local CODEX_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-home-'));
  try {
    const env = buildCodexHomeEnv({
      HOME: home,
      PATH: '/usr/bin',
      CODEX_OVERLEAF_CODEX_PATH: '/usr/local/bin/codex'
    });

    assert.equal(env.CODEX_HOME, path.join(home, '.codex-overleaf', 'codex-home'));
    assert.equal(env.CODEX_OVERLEAF_CODEX_HOME, path.join(home, '.codex-overleaf', 'codex-home'));
    assert.equal(env.CODEX_OVERLEAF_USER_CODEX_HOME, path.join(home, '.codex'));
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CODEX_OVERLEAF_CODEX_PATH, '/usr/local/bin/codex');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('clearing plugin Codex history never removes the user global Codex sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-home-'));
  const userSessionFile = path.join(home, '.codex', 'sessions', '2026', '05', '02', 'user.jsonl');
  const pluginSessionFile = path.join(getPluginCodexHome({ HOME: home }), 'sessions', '2026', '05', '02', 'plugin.jsonl');
  const pluginArchiveFile = path.join(getPluginCodexHome({ HOME: home }), 'archived_sessions', 'archived.jsonl');
  try {
    fs.mkdirSync(path.dirname(userSessionFile), { recursive: true });
    fs.mkdirSync(path.dirname(pluginSessionFile), { recursive: true });
    fs.mkdirSync(path.dirname(pluginArchiveFile), { recursive: true });
    fs.writeFileSync(userSessionFile, '{"source":"vscode"}\n', 'utf8');
    fs.writeFileSync(pluginSessionFile, '{"source":"overleaf-plugin"}\n', 'utf8');
    fs.writeFileSync(pluginArchiveFile, '{"source":"overleaf-plugin"}\n', 'utf8');

    const result = clearPluginCodexHistory({ HOME: home });

    assert.deepEqual(result.removed.sort(), ['archived_sessions', 'sessions']);
    assert.equal(fs.existsSync(pluginSessionFile), false);
    assert.equal(fs.existsSync(pluginArchiveFile), false);
    assert.equal(fs.existsSync(userSessionFile), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('clearing plugin Codex history by thread id removes only that Codex thread', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-home-'));
  const userSessionFile = path.join(home, '.codex', 'sessions', '2026', '05', '02', 'user.jsonl');
  const pluginThreadFile = path.join(getPluginCodexHome({ HOME: home }), 'sessions', '2026', '05', '02', 'thread-a.jsonl');
  const otherPluginThreadFile = path.join(getPluginCodexHome({ HOME: home }), 'sessions', '2026', '05', '02', 'thread-a-extra.jsonl');
  const archivedThreadFile = path.join(getPluginCodexHome({ HOME: home }), 'archived_sessions', '2026', '05', '02', 'thread-a.jsonl');
  try {
    fs.mkdirSync(path.dirname(userSessionFile), { recursive: true });
    fs.mkdirSync(path.dirname(pluginThreadFile), { recursive: true });
    fs.mkdirSync(path.dirname(archivedThreadFile), { recursive: true });
    fs.writeFileSync(userSessionFile, '{"id":"thread-a","source":"vscode"}\n', 'utf8');
    fs.writeFileSync(pluginThreadFile, '{"threadId":"thread-a","source":"overleaf-plugin"}\n', 'utf8');
    fs.writeFileSync(otherPluginThreadFile, '{"threadId":"thread-a-extra","source":"overleaf-plugin"}\n', 'utf8');
    fs.writeFileSync(archivedThreadFile, '{"threadId":"thread-a","source":"overleaf-plugin"}\n', 'utf8');

    const result = clearPluginCodexHistory({ threadId: 'thread-a' }, { HOME: home });

    assert.equal(result.scope, 'thread');
    assert.deepEqual(result.removed.sort(), [
      'archived_sessions/2026/05/02/thread-a.jsonl',
      'sessions/2026/05/02/thread-a.jsonl'
    ]);
    assert.equal(fs.existsSync(pluginThreadFile), false);
    assert.equal(fs.existsSync(archivedThreadFile), false);
    assert.equal(fs.existsSync(otherPluginThreadFile), true);
    assert.equal(fs.existsSync(userSessionFile), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bundled annotated-rewrite SKILL.md is present and non-empty', () => {
  const skillPath = path.resolve(__dirname, '../native-host/src/skills/annotated-rewrite/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert.ok(content.length > 0);
  assert.match(content, /annotated-rewrite/);
});

test('ensureDefaultCodexOverleafSkills restores official skill after deletion', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-default-skills-'));
  const overleafSkillsRoot = path.join(home, '.codex-overleaf', 'skills');
  const env = { HOME: home, CODEX_OVERLEAF_SKILLS_ROOT: overleafSkillsRoot };
  try {
    ensureDefaultCodexOverleafSkills({ env });
    const skillPath = path.join(overleafSkillsRoot, 'annotated-rewrite', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath));

    // Delete it and re-run
    fs.rmSync(skillPath, { force: true });
    assert.ok(!fs.existsSync(skillPath));

    ensureDefaultCodexOverleafSkills({ env });
    assert.ok(fs.existsSync(skillPath));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensureDefaultCodexOverleafSkills installs content matching the bundled SKILL.md', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-default-skills-'));
  const overleafSkillsRoot = path.join(home, '.codex-overleaf', 'skills');
  const env = { HOME: home, CODEX_OVERLEAF_SKILLS_ROOT: overleafSkillsRoot };
  try {
    ensureDefaultCodexOverleafSkills({ env });
    const installed = fs.readFileSync(
      path.join(overleafSkillsRoot, 'annotated-rewrite', 'SKILL.md'),
      'utf8'
    );
    const bundled = fs.readFileSync(
      path.resolve(__dirname, '../native-host/src/skills/annotated-rewrite/SKILL.md'),
      'utf8'
    );
    assert.equal(installed, bundled);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preparePluginCodexHome automatically installs the annotated-rewrite skill', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-default-skills-'));
  const overleafSkillsRoot = path.join(home, '.codex-overleaf', 'skills');
  const env = { HOME: home, CODEX_OVERLEAF_SKILLS_ROOT: overleafSkillsRoot };
  try {
    preparePluginCodexHome(env);
    const skillPath = path.join(overleafSkillsRoot, 'annotated-rewrite', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath));
    assert.ok(fs.readFileSync(skillPath, 'utf8').length > 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex config strips only the top-level personality key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-personality-'));
  const userCodexHome = path.join(home, '.codex');
  const pluginConfigPath = path.join(home, '.codex-overleaf', 'codex-home', 'config.toml');
  try {
    fs.mkdirSync(userCodexHome, { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'config.toml'), [
      'model = "gpt-5.5"',
      'personality = "Answer in the third person."',
      '',
      '[features]',
      'multi_agent = true',
      '',
      '[model_providers.openai_official]',
      'name = "OpenAI Official"',
      'personality = "provider-scoped value"'
    ].join('\n'), 'utf8');

    // Both toggle states: the personality strip (Layer A) is unconditional. Layer B skill-config stripping is covered separately by the "strips local plugin config" test.
    for (const loadCodexLocalSkills of [true, false]) {
      preparePluginCodexHome({ HOME: home }, { loadCodexLocalSkills });
      const pluginConfig = fs.readFileSync(pluginConfigPath, 'utf8');

      assert.doesNotMatch(pluginConfig, /Answer in the third person/);
      assert.match(pluginConfig, /model = "gpt-5\.5"/);
      assert.match(pluginConfig, /\[features\]/);
      assert.match(pluginConfig, /personality = "provider-scoped value"/);
      assert.equal((pluginConfig.match(/^\s*personality\s*=/gm) || []).length, 1);
    }

    assert.match(
      fs.readFileSync(path.join(userCodexHome, 'config.toml'), 'utf8'),
      /personality = "Answer in the third person\."/
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex config strips multi-line personality values (basic and literal)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-personality-multiline-'));
  const userCodexHome = path.join(home, '.codex');
  const userConfigPath = path.join(userCodexHome, 'config.toml');
  const pluginConfigPath = path.join(home, '.codex-overleaf', 'codex-home', 'config.toml');
  try {
    fs.mkdirSync(userCodexHome, { recursive: true });

    fs.writeFileSync(userConfigPath, [
      'model = "gpt-5.5"',
      'personality = """',
      'Answer in the third person.',
      'Avoid the X-not-Y pattern.',
      '"""',
      '',
      '[features]',
      'multi_agent = true'
    ].join('\n'), 'utf8');
    preparePluginCodexHome({ HOME: home }, { loadCodexLocalSkills: true });
    let pluginConfig = fs.readFileSync(pluginConfigPath, 'utf8');
    assert.doesNotMatch(pluginConfig, /personality/);
    assert.doesNotMatch(pluginConfig, /third person/);
    assert.doesNotMatch(pluginConfig, /X-not-Y/);
    assert.match(pluginConfig, /model = "gpt-5\.5"/);
    assert.match(pluginConfig, /\[features\]/);

    fs.writeFileSync(userConfigPath, [
      'model = "gpt-5.5"',
      "personality = '''",
      'Literal personality line.',
      "'''",
      '',
      '[features]',
      'multi_agent = true'
    ].join('\n'), 'utf8');
    preparePluginCodexHome({ HOME: home }, { loadCodexLocalSkills: true });
    pluginConfig = fs.readFileSync(pluginConfigPath, 'utf8');
    assert.doesNotMatch(pluginConfig, /personality/);
    assert.doesNotMatch(pluginConfig, /Literal personality line/);
    assert.match(pluginConfig, /model = "gpt-5\.5"/);
    assert.match(pluginConfig, /\[features\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home does not inherit the user global AGENTS.md', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-agents-'));
  const userCodexHome = path.join(home, '.codex');
  try {
    fs.mkdirSync(userCodexHome, { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'AGENTS.md'), 'Answer in the third person.\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"token":"user-token"}\n', 'utf8');

    preparePluginCodexHome({ HOME: home });
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');

    assert.equal(fs.existsSync(path.join(pluginHome, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'auth.json')), true);
    assert.equal(fs.readFileSync(path.join(userCodexHome, 'AGENTS.md'), 'utf8'), 'Answer in the third person.\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home does not symlink the user global rules and memories', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-rules-memories-'));
  const userCodexHome = path.join(home, '.codex');
  try {
    fs.mkdirSync(path.join(userCodexHome, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(userCodexHome, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'rules', 'default.rules'), 'allow\n', 'utf8');

    preparePluginCodexHome({ HOME: home });
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');

    assert.equal(fs.existsSync(path.join(pluginHome, 'rules')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'memories')), false);
    assert.equal(fs.existsSync(path.join(userCodexHome, 'rules', 'default.rules')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home removes stale AGENTS.md and rules/memories left by earlier runs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-stale-'));
  const userCodexHome = path.join(home, '.codex');
  const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
  try {
    fs.mkdirSync(path.join(userCodexHome, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(userCodexHome, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'rules', 'sentinel.txt'), 'survives\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'memories', 'sentinel.txt'), 'survives\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"token":"user-token"}\n', 'utf8');
    fs.mkdirSync(pluginHome, { recursive: true });
    fs.writeFileSync(path.join(pluginHome, 'AGENTS.md'), 'stale global guidance\n', 'utf8');
    fs.symlinkSync(path.join(userCodexHome, 'rules'), path.join(pluginHome, 'rules'), 'dir');
    fs.symlinkSync(path.join(userCodexHome, 'memories'), path.join(pluginHome, 'memories'), 'dir');

    preparePluginCodexHome({ HOME: home });

    assert.equal(fs.existsSync(path.join(pluginHome, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'rules')), false);
    assert.equal(fs.existsSync(path.join(pluginHome, 'memories')), false);
    assert.equal(fs.existsSync(path.join(userCodexHome, 'rules')), true);
    assert.equal(fs.existsSync(path.join(userCodexHome, 'memories')), true);
    assert.equal(fs.existsSync(path.join(userCodexHome, 'rules', 'sentinel.txt')), true);
    assert.equal(fs.existsSync(path.join(userCodexHome, 'memories', 'sentinel.txt')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plugin Codex home removes a stale config.toml when the user config.toml is gone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-missing-config-'));
  const userCodexHome = path.join(home, '.codex');
  const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
  try {
    fs.mkdirSync(userCodexHome, { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"token":"user-token"}\n', 'utf8');
    fs.mkdirSync(pluginHome, { recursive: true });
    fs.writeFileSync(path.join(pluginHome, 'config.toml'), 'personality = "stale"\n', 'utf8');

    preparePluginCodexHome({ HOME: home });

    assert.equal(fs.existsSync(path.join(pluginHome, 'config.toml')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preparePluginCodexHome copies and rewrites the configured relative model catalog', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-model-catalog-'));
  try {
    const userHome = path.join(home, '.codex');
    fs.mkdirSync(path.join(userHome, 'catalogs'), { recursive: true });
    fs.writeFileSync(path.join(userHome, 'config.toml'), [
      'model = "gpt-custom"',
      'model_catalog_json = "catalogs/custom-models.json"',
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(userHome, 'catalogs', 'custom-models.json'), '{"models":[]}', 'utf8');

    const prepared = preparePluginCodexHome({ HOME: home });
    const copiedCatalog = path.join(prepared.pluginHome, 'model_catalog.json');
    const pluginConfig = fs.readFileSync(path.join(prepared.pluginHome, 'config.toml'), 'utf8');

    assert.equal(fs.readFileSync(copiedCatalog, 'utf8'), '{"models":[]}');
    assert.match(pluginConfig, /^model_catalog_json = "model_catalog\.json"$/m);
    assert.equal(prepared.modelCatalog?.status, 'copied');
    assert.equal(prepared.copied.includes('model_catalog.json'), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preparePluginCodexHome supports quoted TOML keys and literal relative catalog paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-quoted-model-catalog-'));
  try {
    const userHome = path.join(home, '.codex');
    fs.mkdirSync(path.join(userHome, 'catalogs'), { recursive: true });
    fs.writeFileSync(
      path.join(userHome, 'config.toml'),
      `'model_catalog_json' = 'catalogs/custom-models.json'\n`,
      'utf8'
    );
    fs.writeFileSync(path.join(userHome, 'catalogs', 'custom-models.json'), '{"quoted":true}', 'utf8');

    const prepared = preparePluginCodexHome({ HOME: home });
    const pluginConfig = fs.readFileSync(path.join(prepared.pluginHome, 'config.toml'), 'utf8');

    assert.equal(
      fs.readFileSync(path.join(prepared.pluginHome, 'model_catalog.json'), 'utf8'),
      '{"quoted":true}'
    );
    assert.match(pluginConfig, /^model_catalog_json = "model_catalog\.json"$/m);
    assert.equal(prepared.modelCatalog?.status, 'copied');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preparePluginCodexHome replaces a stale catalog symlink without modifying its target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-model-catalog-symlink-'));
  try {
    const userHome = path.join(home, '.codex');
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
    const victim = path.join(home, 'victim.json');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(pluginHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, 'config.toml'), 'model_catalog_json = "custom.json"\n', 'utf8');
    fs.writeFileSync(path.join(userHome, 'custom.json'), '{"fresh":true}', 'utf8');
    fs.writeFileSync(victim, '{"victim":true}', 'utf8');
    fs.symlinkSync(victim, path.join(pluginHome, 'model_catalog.json'));

    preparePluginCodexHome({ HOME: home });

    const targetStat = fs.lstatSync(path.join(pluginHome, 'model_catalog.json'));
    assert.equal(targetStat.isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(pluginHome, 'model_catalog.json'), 'utf8'), '{"fresh":true}');
    assert.equal(fs.readFileSync(victim, 'utf8'), '{"victim":true}');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preparePluginCodexHome removes a stale copied model catalog when configuration no longer references one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-stale-model-catalog-'));
  try {
    const userHome = path.join(home, '.codex');
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(pluginHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, 'config.toml'), 'model = "gpt-default"\n', 'utf8');
    fs.writeFileSync(path.join(pluginHome, 'model_catalog.json'), '{"stale":true}', 'utf8');

    const prepared = preparePluginCodexHome({ HOME: home });

    assert.equal(fs.existsSync(path.join(pluginHome, 'model_catalog.json')), false);
    assert.equal(prepared.modelCatalog?.status, 'not_configured');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preparePluginCodexHome reports a missing configured model catalog without copying stale data', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-missing-model-catalog-'));
  try {
    const userHome = path.join(home, '.codex');
    const pluginHome = path.join(home, '.codex-overleaf', 'codex-home');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(pluginHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, 'config.toml'), 'model_catalog_json = "missing.json"\n', 'utf8');
    fs.writeFileSync(path.join(pluginHome, 'model_catalog.json'), '{"stale":true}', 'utf8');

    const prepared = preparePluginCodexHome({ HOME: home });

    assert.equal(fs.existsSync(path.join(pluginHome, 'model_catalog.json')), false);
    assert.equal(prepared.modelCatalog?.status, 'missing');
    assert.match(prepared.modelCatalog?.source || '', /missing\.json$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preparePluginCodexHome leaves a shared user/plugin home untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-samepath-'));
  const sharedHome = path.join(home, 'shared-codex');
  try {
    fs.mkdirSync(path.join(sharedHome, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(sharedHome, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(sharedHome, 'AGENTS.md'), 'shared guidance\n', 'utf8');

    const prepared = preparePluginCodexHome({
      HOME: home,
      CODEX_OVERLEAF_USER_CODEX_HOME: sharedHome,
      CODEX_OVERLEAF_CODEX_HOME: sharedHome
    });

    assert.equal(prepared.userHome, prepared.pluginHome);
    assert.equal(fs.existsSync(path.join(sharedHome, 'AGENTS.md')), true);
    assert.equal(fs.existsSync(path.join(sharedHome, 'rules')), true);
    assert.equal(fs.existsSync(path.join(sharedHome, 'memories')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
