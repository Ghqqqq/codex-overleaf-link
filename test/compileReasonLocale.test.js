'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Compile = require('../extension/src/shared/compileAdapter');
const Bridge = require('../extension/src/page/compileBridge');
const { extractFunction } = require('./_helpers/extractFunction');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8');

function consumer(locale, bridgeResult, thrown) {
  const events = [], calls = [];
  const context = { compileAdapter: Compile, getLocale: () => locale,
    getState: () => ({ mode: 'auto', autoRecompile: true }), tx: (en, zh) => locale === 'zh' ? zh : en,
    serverProvenSave: () => false, appendRunEvent: event => events.push(event), getCurrentRunView: () => null,
    getCurrentProjectId: () => 'qa-project', callPageBridge: async (method, params) => {
      calls.push({ method, params }); if (thrown) throw thrown; return bridgeResult;
    }, buildPostWriteCompileSummary: input => Compile.buildPostWriteCompileSummary(input) };
  return { events, calls,
    run: vm.runInNewContext('(' + extractFunction(source, 'autoRecompileAfterWriteback') + ')', context),
    conclusion: vm.runInNewContext('(' + extractFunction(source, 'appendCompileSummaryToConclusion') + ')', context) };
}

test('real Page compile failure is localized in Chinese activity and conclusion without changing evidence', async () => {
  const bridge = Bridge.create({ window: {}, document: { querySelectorAll: () => [] },
    waitForSaveState: async () => ({ state: 'verified_saved', ok: true }) });
  const result = await bridge.triggerCompile();
  assert.equal(result.reason, 'No Overleaf Recompile button or compile request template is available.');
  const saved = JSON.stringify(result), h = consumer('zh', result);
  const summary = await h.run(['main.tex'], { state: 'verified_saved' }, { runProjectId: 'qa-project' });
  assert.equal(h.events.at(-1).title, '写后编译未成功：没有可用的 Overleaf 重新编译按钮或编译请求模板。');
  assert.equal(h.events.at(-1).activity.output, '没有可用的 Overleaf 重新编译按钮或编译请求模板。');
  assert.equal(h.conclusion('原结论', summary), '原结论\n写后编译检查失败：没有可用的 Overleaf 重新编译按钮或编译请求模板。');
  assert.equal(summary.reason, result.reason);
  assert.equal(summary.status, 'failed');
  assert.equal(h.calls[0].params.runProjectId, 'qa-project');
  assert.equal(JSON.stringify(result), saved);
});

test('compile failure English view and external thrown diagnostics remain intact', async () => {
  const raw = 'External TeX diagnostic: 未定义命令 \\sample';
  const h = consumer('en', null, new Error(raw));
  const summary = await h.run(['main.tex'], { state: 'verified_saved' });
  assert.equal(h.events.at(-1).activity.output, raw);
  assert.equal(h.conclusion('', summary), 'Post-write compile check failed: ' + raw);
  const chinese = consumer('zh', null, new Error(raw));
  const zh = await chinese.run(['main.tex'], { state: 'verified_saved' });
  assert.equal(chinese.events.at(-1).title, '写后编译出错：' + raw);
  assert.equal(zh.reason, raw);
});

test('known save and compile templates translate in both directions; unknown content stays literal', () => {
  const pairs = [
    ['Compile succeeded.', '编译成功。'],
    ['Overleaf compile was triggered. The page will continue showing progress.', '已触发 Overleaf 编译；页面会继续显示编译进度。'],
    ['Fetching compile log (@compile-log).', '正在获取编译日志 (@compile-log)。'],
    ['Post-write compile did not succeed: No compile log URL available', '写后编译未成功：没有可用的编译日志地址'],
    ['Post-write compile failed: No compile log URL available', '写后编译出错：没有可用的编译日志地址'],
    ['Compile log unavailable: No compile log URL available', '编译日志不可用：没有可用的编译日志地址'],
    ['Overleaf is offline; saving cannot be confirmed.', 'Overleaf 当前离线，无法确认保存。'],
    ['Compile request failed with status 503', '编译请求失败，状态码为 503'],
    ['Failed to fetch compile log: 404', '获取编译日志失败，状态码为 404'],
    ['Timed out waiting for a verified Overleaf save state. Overleaf save indicator was not found.', '等待确认 Overleaf 保存状态超时。未找到 Overleaf 保存指示器。'],
    ['Could not get fresh compile: No compile log URL available', '无法获取最新编译结果：没有可用的编译日志地址']
  ];
  for (const [en, zh] of pairs) {
    assert.equal(Compile.localizeCompileReason(en, 'zh'), zh);
    assert.equal(Compile.localizeCompileReason(zh, 'en'), en);
  }
  const external = 'Log fetch error: upstream diagnostic 用户原文';
  assert.equal(Compile.localizeCompileReason(external, 'zh'), '获取日志出错：upstream diagnostic 用户原文');
  assert.equal(Compile.localizeCompileReason('Log fetch error:   upstream diagnostic', 'zh'), '获取日志出错：  upstream diagnostic');
  assert.equal(Compile.localizeCompileReason('Timed out waiting for a verified Overleaf save state.custom output', 'zh'), 'Timed out waiting for a verified Overleaf save state.custom output');
  assert.equal(Compile.localizeCompileReason('This external line mentions No compile log URL available', 'zh'), 'This external line mentions No compile log URL available');
  assert.equal(Compile.localizeCompileReason('! LaTeX Error: Missing $ inserted.', 'zh'), '! LaTeX Error: Missing $ inserted.');
});
