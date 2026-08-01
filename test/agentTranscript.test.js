const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildHumanCompletionReport,
  buildStructuredHumanReport,
  formatHumanReport,
  mapAgentEventToActivity,
  stripEmptyHtmlCommentPlaceholders,
  translateRawError
} = require('../extension/src/shared/agentTranscript');

test('defaults missing locale to English for user-facing remediation', () => {
  const translated = translateRawError('Mode must be "confirm" or "auto"', { mode: 'ask' });

  assert.equal(translated.conclusion, 'No files were written: this task needs write access, but the current mode is Ask.');
  assert.equal(translated.nextStep, 'Switch to Auto and run the task again.');
  assert.doesNotMatch(JSON.stringify(translated), /Mode must be/);
});

test('translates raw errors in English when the panel locale is English', () => {
  const translated = translateRawError('Mode must be "confirm" or "auto"', { mode: 'ask', locale: 'en' });

  assert.equal(translated.conclusion, 'No files were written: this task needs write access, but the current mode is Ask.');
  assert.equal(translated.nextStep, 'Switch to Auto and run the task again.');
  assert.doesNotMatch(JSON.stringify(translated), /Mode must be/);
});

test('translates the removed Suggest compatibility error', () => {
  const translated = translateRawError('suggest_mode_removed: Suggest mode has been removed.', { locale: 'en' });

  assert.equal(translated.failureCode, 'suggest_mode_removed');
  assert.equal(translated.nextStep, 'Reload the extension, then choose Ask or Auto.');
});

test('timeout remediation does not tell users to raise a default Codex timeout', () => {
  const translated = translateRawError('Codex app-server timed out after 600000ms', { locale: 'zh' });

  assert.equal(translated.conclusion, '这轮没有写入：本地 Codex 长时间没有完成。');
  assert.doesNotMatch(translated.nextStep, /提高超时时间|timeout/i);
});

test('unknown ask-mode errors explain local Codex failure without implying the analysis succeeded silently', () => {
  const translated = translateRawError('unexpected app-server failure', { mode: 'ask', locale: 'zh' });

  assert.doesNotMatch(translated.conclusion, /没有返回可用说明/);
  assert.match(translated.conclusion, /本地 Codex 没有正常完成/);
  assert.match(translated.nextStep, /技术详情/);
});

test('unsupported reasoning summary errors explain model parameter compatibility', () => {
  const translated = translateRawError('Unsupported parameter: reasoning.summary is not supported with the gpt-5.3-codex-spark model.', { locale: 'zh' });

  assert.equal(translated.conclusion, '这轮没有继续：当前 Codex 模型不支持插件请求的推理摘要参数。');
  assert.match(translated.nextStep, /刷新扩展|重新运行/);
  assert.doesNotMatch(JSON.stringify(translated), /没有返回可用结果/);
});

test('keeps schema-only lifecycle events out of the visible transcript', () => {
  for (const event of [
    { type: 'codex.prompt.ready', title: 'Codex prompt prepared' },
    { type: 'codex.stdout.line', title: 'Codex produced non-JSON output', detail: { text: '{"raw":true}' } }
  ]) {
    const activity = mapAgentEventToActivity(event);
    assert.equal(activity.kind, 'technical');
    assert.equal(activity.visible, false);
  }
});

test('maps project sync events to visible human progress without temp paths', () => {
  const preparing = mapAgentEventToActivity({
    type: 'agent.snapshot.preparing',
    detail: { fileCount: 13, totalChars: 42000 }
  }, { locale: 'zh' });
  const ready = mapAgentEventToActivity({
    type: 'agent.snapshot.ready',
    detail: { tempDir: '/tmp/codex-overleaf-agent-secret', fileCount: 13 }
  }, { locale: 'zh' });

  assert.equal(preparing.visible, true);
  assert.match(preparing.title, /正在同步 Overleaf 项目/);
  assert.equal(ready.visible, true);
  assert.match(ready.title, /已同步 13 个文本文件/);
  assert.doesNotMatch(ready.title, /tmp|codex-overleaf-agent/);
});

test('maps native glue sync events to the same visible Overleaf workspace story', () => {
  const started = mapAgentEventToActivity({
    type: 'overleaf.sync.started',
    detail: { fileCount: 13, projectId: 'aabbccddeeff001122334455' }
  }, { locale: 'zh' });
  const completed = mapAgentEventToActivity({
    type: 'overleaf.sync.completed',
    detail: { fileCount: 13, workspacePath: '/tmp/private/path' }
  }, { locale: 'zh' });
  const changes = mapAgentEventToActivity({
    type: 'overleaf.sync.changes',
    detail: { changedCount: 2, files: ['main.tex', 'refs.bib'] }
  }, { locale: 'zh' });

  assert.equal(started.visible, true);
  assert.match(started.title, /正在同步 Overleaf 项目到本地 Codex workspace/);
  assert.equal(completed.visible, true);
  assert.match(completed.title, /本地 Codex 将直接处理这份 workspace/);
  assert.doesNotMatch(completed.title, /tmp|private/);
  assert.equal(changes.visible, true);
  assert.match(changes.title, /Codex 本地改动已收集：main\.tex、refs\.bib/);
});

test('maps native glue sync events in English when requested', () => {
  const started = mapAgentEventToActivity({
    type: 'overleaf.sync.started',
    detail: { fileCount: 4 }
  }, { locale: 'en' });
  const completed = mapAgentEventToActivity({
    type: 'overleaf.sync.completed',
    detail: { fileCount: 4 }
  }, { locale: 'en' });

  assert.equal(started.title, 'Syncing the Overleaf project into the local Codex workspace: 4 text files.');
  assert.equal(completed.title, 'Synced 4 text files. Local Codex will work from this workspace.');
});

test('maps Codex app-server events to native-feeling transcript lines', () => {
  const plan = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'turn/plan/updated',
    detail: {
      method: 'turn/plan/updated',
      params: {
        plan: [
          { step: '检查 main.tex 中的 citation key', status: 'in_progress' },
          { step: '核对 bibliography 文件', status: 'pending' }
        ]
      }
    }
  }, { locale: 'zh' });
  const reasoning = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/reasoning/summaryTextDelta',
    detail: {
      method: 'item/reasoning/summaryTextDelta',
      params: { delta: '先定位 citation 使用点，再核对 bib 条目。' }
    }
  }, { locale: 'zh' });
  const patch = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/fileChange/patchUpdated',
    detail: {
      method: 'item/fileChange/patchUpdated',
      params: {
        changes: [
          { path: 'main.tex', kind: 'update', diff: '...' }
        ]
      }
    }
  }, { locale: 'zh' });

  assert.equal(plan.visible, true);
  assert.match(plan.title, /Codex 计划更新：检查 main\.tex/);
  assert.equal(reasoning.visible, true);
  assert.equal(reasoning.kind, 'stream');
  assert.equal(reasoning.title, '先定位 citation 使用点，再核对 bib 条目。');
  assert.equal(reasoning.streamKey, 'reasoning:current');
  assert.equal(reasoning.technicalDetail, undefined);
  assert.equal(patch.visible, true);
  assert.match(patch.title, /Codex 正在修改本地文件：main\.tex/);
  assert.doesNotMatch(plan.title + reasoning.title + patch.title, /turn\/|item\/|schema|JSON/);
});

test('keeps raw reasoning text out of the visible transcript', () => {
  const activity = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/reasoning/textDelta',
    detail: {
      method: 'item/reasoning/textDelta',
      params: { delta: 'private chain-of-thought fragment' }
    }
  }, { locale: 'zh' });

  assert.equal(activity.kind, 'technical');
  assert.equal(activity.visible, false);
  assert.doesNotMatch(activity.title || '', /private chain-of-thought/);
});

test('maps Codex context compaction to a lightweight visible checkpoint', () => {
  const activity = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'context/compacted',
    status: 'completed',
    detail: {
      method: 'context/compacted',
      params: {
        beforeTokens: 241000,
        afterTokens: 82000
      }
    }
  }, { locale: 'zh' });

  assert.equal(activity.kind, 'checkpoint');
  assert.equal(activity.visible, true);
  assert.equal(activity.status, 'completed');
  assert.equal(activity.title, '上下文已压缩，Codex 继续处理。');
  assert.doesNotMatch(activity.title, /token|schema|JSON|技术详情/i);
});

test('maps assistant message deltas to one updatable stream', () => {
  const first = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/agentMessage/delta',
    detail: {
      method: 'item/agentMessage/delta',
      params: { itemId: 'msg_1', delta: '我先检查 citation ' }
    }
  });
  const second = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/agentMessage/delta',
    detail: {
      method: 'item/agentMessage/delta',
      params: { itemId: 'msg_1', delta: '是否都在 ref.bib 中。' }
    }
  });

  assert.equal(first.kind, 'stream');
  assert.equal(second.kind, 'stream');
  assert.equal(first.streamKey, 'agent:msg_1');
  assert.equal(second.streamKey, 'agent:msg_1');
  assert.equal(first.appendText, true);
  assert.equal(first.technicalDetail, undefined);
});

test('preserves spaces at Codex stream delta boundaries', () => {
  const first = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/reasoning/summaryTextDelta',
    detail: {
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reason_1', delta: 'Deciding on file deletion ' }
    }
  });
  const second = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/reasoning/summaryTextDelta',
    detail: {
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reason_1', delta: 'I’m wondering if main.pdf existed before' }
    }
  });

  assert.equal(first.kind, 'stream');
  assert.equal(second.kind, 'stream');
  assert.equal(first.title, 'Deciding on file deletion ');
  assert.equal(second.title, 'I’m wondering if main.pdf existed before');
});

test('removes empty HTML comment placeholders from reasoning streams only', () => {
  const reasoning = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/reasoning/summaryTextDelta',
    detail: {
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reason_1', delta: 'Checking current line ending\n\n<!-- -->' }
    }
  });
  const assistant = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/agentMessage/delta',
    detail: {
      method: 'item/agentMessage/delta',
      params: { itemId: 'msg_1', delta: 'HTML example: <!-- -->' }
    }
  });

  assert.equal(reasoning.title, 'Checking current line ending\n\n');
  assert.equal(assistant.title, 'HTML example: <!-- -->');
});

test('reasoning placeholder cleanup handles split stream fragments and preserves meaningful comments', () => {
  const first = stripEmptyHtmlCommentPlaceholders('Including economic constraints\n\n<!--');
  const accumulated = stripEmptyHtmlCommentPlaceholders(first + ' -->');

  assert.equal(first, 'Including economic constraints\n\n');
  assert.equal(accumulated, 'Including economic constraints\n\n');
  assert.equal(stripEmptyHtmlCommentPlaceholders('Keep <!-- reviewer note --> here'), 'Keep <!-- reviewer note --> here');
});

test('maps Codex command events to visible natural progress without raw commands', () => {
  const started = mapAgentEventToActivity({
    type: 'codex.command.started',
    detail: { command: 'rg citation main.tex' }
  }, { locale: 'zh' });
  const completed = mapAgentEventToActivity({
    type: 'codex.command.completed',
    detail: {
      command: 'rg citation main.tex',
      output: '1:\\cite{a}\n2:\\cite{b}\n',
      exitCode: 0
    }
  }, { locale: 'zh' });

  assert.equal(started.visible, true);
  assert.equal(started.status, 'running');
  assert.match(started.title, /正在搜索项目内容/);
  assert.doesNotMatch(started.title, /rg citation main\.tex/);
  assert.equal(completed.visible, true);
  assert.equal(completed.status, 'completed');
  assert.match(completed.title, /搜索完成，找到 2 条相关线索/);
  assert.doesNotMatch(completed.title, /rg citation main\.tex|\\cite/);
});

test('maps human agent messages to visible progress without speaker labels', () => {
  const activity = mapAgentEventToActivity({
    type: 'codex.agent.message',
    detail: {
      text: '我会先检查 main.tex 里的引用，再和 references.bib 对照。'
    }
  });

  assert.equal(activity.kind, 'activity');
  assert.equal(activity.visible, true);
  assert.equal(activity.title, '我会先检查 main.tex 里的引用，再和 references.bib 对照。');
  assert.doesNotMatch(activity.title, /Codex 说/);
});

test('formats userReport as a readable final report', () => {
  const report = buildHumanCompletionReport({
    locale: 'zh',
    status: 'completed',
    userReport: {
      conclusion: '没有发现缺失 citation key，也没有修改文件。',
      checked: ['main.tex', 'references.bib'],
      findings: ['4 个 citation key 都能在 .bib 中找到对应条目。'],
      plannedChanges: [],
      appliedChanges: [],
      unchangedReason: '这轮是只问不改。',
      nextStep: '如果 Overleaf 仍有 warning，请把编译日志加入 @context 后再跑一次。'
    },
    operations: [
      { type: 'edit', path: 'main.tex', find: 'old', replace: 'new' }
    ]
  });

  assert.equal(report.title, '本轮完成报告');
  assert.match(report.text, /结论：没有发现缺失 citation key，也没有修改文件。/);
  assert.match(report.text, /检查范围：\n- main\.tex\n- references\.bib/);
  assert.match(report.text, /发现：\n- 4 个 citation key/);
  assert.match(report.text, /未修改原因：这轮是只问不改。/);
  assert.match(report.text, /下一步：如果 Overleaf 仍有 warning/);
  assert.doesNotMatch(report.text, /"type"|"find"|"replace"|old|new/);
});

test('preserves markdown sections in Codex final assistant reports', () => {
  const finalAnswer = [
    '我检查了主稿 [main.tex](/Users/example/.codex-overleaf/projects/p/workspace/main.tex:1)。',
    '',
    '**优先改**',
    '- [main.tex:117](/Users/example/.codex-overleaf/projects/p/workspace/main.tex:117)：`\\label{fig: example}` 应改成 `\\label{fig:example}`。',
    '- [checklist.tex:56](/Users/example/.codex-overleaf/projects/p/workspace/checklist.tex:56)：`In general.` 应改成 `In general,`。'
  ].join('\n');

  const report = buildHumanCompletionReport({
    locale: 'zh',
    status: 'completed',
    conclusion: finalAnswer,
    operations: [],
    applyResults: []
  });

  assert.match(report.text, /结论：我检查了主稿 \[main\.tex\]/);
  assert.match(report.text, /\n\n\*\*优先改\*\*\n- \[main\.tex:117\]/);
  assert.doesNotMatch(report.text, /\*\*优先改\*\* - \[main\.tex:117\]/);
});

test('builds fallback final reports without raw operation JSON', () => {
  const report = buildHumanCompletionReport({
    locale: 'zh',
    status: 'completed',
    notes: '已润色摘要的一句话。',
    operations: [
      { type: 'edit', path: 'main.tex', find: 'old', replace: 'new', reason: '语法更自然' }
    ],
    applyResults: [
      {
        applied: [{ operation: { type: 'edit', path: 'main.tex' }, result: { status: 'ok' } }],
        skipped: []
      }
    ],
    undoCount: 1
  });

  assert.match(report.text, /结论：已润色摘要的一句话。/);
  assert.match(report.text, /修改：\n- main\.tex：编辑/);
  assert.match(report.text, /写入结果：已写入 1 项，跳过 0 项/);
  assert.match(report.text, /可撤销：可撤销本轮 1 项写入/);
  assert.doesNotMatch(report.text, /"type"|"find"|"replace"|old|new/);
});

test('builds fallback final reports in English when requested', () => {
  const report = buildHumanCompletionReport({
    locale: 'en',
    status: 'completed',
    notes: 'Updated the abstract.',
    operations: [
      { type: 'edit', path: 'main.tex', reason: 'improve grammar' }
    ],
    applyResults: [
      {
        applied: [{ operation: { type: 'edit', path: 'main.tex' }, result: { status: 'ok' } }],
        skipped: []
      }
    ],
    undoCount: 1,
    includeWriteResult: true
  });

  assert.equal(report.title, 'Task report');
  assert.match(report.text, /Conclusion: Updated the abstract\./);
  assert.match(report.text, /Changes:\n- main\.tex: edit/);
  assert.match(report.text, /Write result: wrote 1 item, skipped 0 items/);
  assert.match(report.text, /Undo: this run has 1 reversible write/);
  assert.doesNotMatch(report.text, /结论|写入结果|可撤销/);
});

test('fallback final reports ignore malformed apply result containers', () => {
  const report = buildHumanCompletionReport({
    locale: 'en',
    status: 'failed',
    operations: [],
    applyResults: [
      { applied: 'x', skipped: { length: 1 } },
      { applied: { length: 1 }, skipped: 'x' }
    ],
    includeWriteResult: true
  });

  assert.match(report.text, /Write result: wrote 0 items, skipped 0 items/);
  assert.doesNotMatch(report.text, /wrote 1 item|skipped 1 item/);
  assert.doesNotMatch(report.text, /Changes:\n- /);
  assert.doesNotMatch(report.text, /Skipped:\n- /);
});

test('local workspace sync reasons are localized in English reports', () => {
  const report = buildHumanCompletionReport({
    locale: 'en',
    status: 'completed',
    notes: 'Local Codex changes were synced back to Overleaf.',
    operations: [
      {
        type: 'edit',
        path: 'draft.tex',
        reasonKey: 'localWorkspacePatch',
        reasonParams: { count: 42 },
        reason: 'Synced 42 local Codex workspace edits.'
      },
      {
        type: 'edit',
        path: 'legacy.tex',
        reason: '同步本地 Codex workspace 中的局部文件改动（2 处）。'
      }
    ],
    applyResults: [],
    includeWriteResult: true
  });

  assert.match(report.text, /draft\.tex: edit \(Synced 42 local Codex workspace edits\.\)/);
  assert.match(report.text, /legacy\.tex: edit \(Synced 2 local Codex workspace edits\.\)/);
  assert.doesNotMatch(report.text, /同步本地|局部文件改动|处/);
});

test('fallback final reports include skipped write reasons directly', () => {
  const report = buildHumanCompletionReport({
    locale: 'zh',
    status: 'failed',
    notes: '本地 Codex 改动已尝试写回 Overleaf。',
    operations: [
      { type: 'edit', path: 'draft.tex', reason: '同步本地 Codex workspace 中的局部文件改动（2 处）。' }
    ],
    applyResults: [
      {
        applied: [],
        skipped: [
          {
            operation: { type: 'edit', path: 'draft.tex' },
            result: {
              code: 'reviewing_not_enabled',
              reason: 'Overleaf Reviewing/Track Changes was not confirmed before writing.'
            }
          }
        ]
      }
    ],
    undoCount: 0,
    includeWriteResult: true
  });

  assert.match(report.text, /计划修改：\n- draft\.tex：编辑/);
  assert.match(report.text, /写入结果：已写入 0 项，跳过 1 项/);
  assert.match(report.text, /- draft\.tex：编辑没有写入/);
  // Structured Reason/Stage/Code/Next block surfaces the canonical code mapping.
  assert.match(report.text, /代码: reviewing_state_unknown/);
  assert.match(report.text, /阶段: reviewing/);
  assert.match(report.text, /可撤销：本轮没有可撤销的写入/);
  assert.doesNotMatch(report.text, /"type"|"code":\s|"result"/);
});

test('fallback final reports localize stale skipped reasons in English', () => {
  const report = buildHumanCompletionReport({
    locale: 'en',
    status: 'failed',
    notes: 'Local Codex changes were sent to Overleaf, but some items were skipped.',
    operations: [
      { type: 'edit', path: 'draft.tex', reasonKey: 'localWorkspacePatch', reasonParams: { count: 2 } }
    ],
    applyResults: [
      {
        applied: [],
        skipped: [
          {
            operation: { type: 'edit', path: 'draft.tex' },
            result: {
              code: 'stale_snapshot',
              reasonKey: 'staleSnapshot',
              reasonParams: { filePath: 'draft.tex' },
              reason: 'draft.tex 在任务执行期间被你或协作者改过，Codex 没有覆盖它。请查看差异后重试。'
            }
          }
        ]
      }
    ],
    undoCount: 0,
    includeWriteResult: true
  });

  assert.match(report.text, /Skipped:\n- draft\.tex: edit was not written/);
  // Legacy stale_snapshot is normalized to canonical stale_source_changed via normalizeFailureReason.
  assert.match(report.text, /Code: stale_source_changed/);
  assert.match(report.text, /Stage: preflight/);
  assert.match(report.text, /Reason: draft\.tex changed while Codex was working/);
  assert.match(report.text, /Next: Review the current file/);
  assert.doesNotMatch(report.text, /任务执行期间|没有覆盖|跳过原因/);
});

test('fallback final reports render structured FailureReason as a four-line block (English)', () => {
  const report = buildHumanCompletionReport({
    locale: 'en',
    status: 'failed',
    notes: '',
    operations: [{ type: 'edit', path: 'example/test2.tex' }],
    applyResults: [
      {
        applied: [],
        skipped: [
          {
            operation: { type: 'edit', path: 'example/test2.tex' },
            result: {
              ok: false,
              failure: {
                code: 'target_file_not_active',
                stage: 'navigation',
                severity: 'blocked',
                userMessage: 'Codex could not write example/test2.tex because Overleaf was still focused on main.tex.',
                nextAction: 'Open example/test2.tex in Overleaf, then retry this run.',
                retryable: true,
                file: 'example/test2.tex',
                activeFile: 'main.tex',
                changedDocument: false
              }
            }
          }
        ]
      }
    ],
    undoCount: 0,
    includeWriteResult: true
  });

  assert.match(report.text, /- example\/test2\.tex: edit was not written/);
  assert.match(report.text, /Reason: Codex could not write example\/test2\.tex/);
  assert.match(report.text, /Stage: navigation/);
  assert.match(report.text, /Code: target_file_not_active/);
  assert.match(report.text, /Next: Open example\/test2\.tex in Overleaf/);
});

test('fallback final reports localize structured failures in Chinese', () => {
  const report = buildHumanCompletionReport({
    locale: 'zh',
    status: 'failed',
    notes: '',
    operations: [{ type: 'edit', path: 'example/test2.tex' }],
    applyResults: [
      {
        applied: [],
        skipped: [
          {
            operation: { type: 'edit', path: 'example/test2.tex' },
            result: { ok: false, code: 'stale_snapshot', reason: 'changed' }
          }
        ]
      }
    ],
    undoCount: 0,
    includeWriteResult: true
  });

  assert.match(report.text, /阶段: preflight/);
  assert.match(report.text, /代码: stale_source_changed/);
  assert.match(report.text, /原因: /);
  assert.match(report.text, /下一步: /);
});

test('fallback final report falls back to normalizeFailureReason for legacy-only results', () => {
  const report = buildHumanCompletionReport({
    locale: 'en',
    status: 'failed',
    operations: [{ type: 'edit', path: 'a.tex' }],
    applyResults: [
      {
        applied: [],
        skipped: [
          {
            operation: { type: 'edit', path: 'a.tex' },
            result: { ok: false, code: 'path_not_found', reason: 'no such file' }
          }
        ]
      }
    ],
    undoCount: 0,
    includeWriteResult: true
  });

  assert.match(report.text, /Code: target_file_not_found/);
  assert.match(report.text, /Stage: navigation/);
});

test('formatFallbackFinalReport exposes structured skipped formatting', () => {
  const transcript = require('../extension/src/shared/agentTranscript');
  const text = transcript.formatFallbackFinalReport({
    apply: {
      applied: [],
      skipped: [{
        operation: { type: 'edit', path: 'example/test2.tex' },
        result: {
          ok: false,
          failure: {
            code: 'target_file_not_active',
            stage: 'navigation',
            severity: 'blocked',
            userMessage: 'Codex could not write example/test2.tex because Overleaf was still focused on main.tex.',
            nextAction: 'Open example/test2.tex in Overleaf, then retry this run.',
            retryable: true,
            file: 'example/test2.tex',
            activeFile: 'main.tex',
            changedDocument: false
          }
        }
      }]
    },
    locale: 'en'
  });
  assert.match(text, /Reason: Codex could not write example\/test2\.tex/);
  assert.match(text, /Stage: navigation/);
  assert.match(text, /Code: target_file_not_active/);
  assert.match(text, /Next: Open example\/test2\.tex in Overleaf/);
});

test('English unchanged reasons translate unsupported local change summaries', () => {
  const report = formatHumanReport({
    conclusion: 'No files changed.',
    unchangedReason: 'Codex 在本地生成了这些文件，但插件没有同步回 Overleaf：\n- main.pdf：LaTeX 构建产物，默认不写回。'
  }, 'en');

  assert.match(report, /Why nothing changed: Codex generated these local files/);
  assert.match(report, /main\.pdf: LaTeX build artifact; not written back by default\./);
  assert.doesNotMatch(report, /插件|同步|构建产物/);
});

test('storage quota errors are not presented as missing ask-mode analysis', () => {
  const report = buildHumanCompletionReport({
    locale: 'zh',
    status: 'failed',
    mode: 'ask',
    errorMessage: 'Resource::kQuotaBytes quota exceeded',
    operations: [],
    applyResults: [],
    includeWriteResult: true
  });

  assert.doesNotMatch(report.text, /本地 Codex 没有返回可用说明/);
  assert.match(report.text, /本地会话记录/);
  assert.match(report.text, /只问不改/);
});

test('formatHumanReport omits empty sections', () => {
  const text = formatHumanReport({
    conclusion: '没有发现问题。',
    checked: [],
    findings: [],
    plannedChanges: [],
    appliedChanges: [],
    unchangedReason: '',
    nextStep: ''
  }, 'zh');

  assert.equal(text, '结论：没有发现问题。');
});

// ---------------------------------------------------------------------------
// Structured human report shape: the renderer uses this to demote system-meta
// fields (Why nothing changed / Write result / Undo / Next) visually away from
// the human-language conclusion. `formatHumanReport` keeps its legacy flat-
// text shape; `buildHumanCompletionReport` returns both `text` (legacy) and
// `structured` (new).
// ---------------------------------------------------------------------------

test('buildStructuredHumanReport separates conclusion from system-meta rows', () => {
  const structured = buildStructuredHumanReport({
    conclusion: '没有发现缺失 citation key，也没有修改文件。',
    checked: ['main.tex', 'references.bib'],
    findings: ['4 个 citation key 都能在 .bib 中找到对应条目。'],
    unchangedReason: '这轮是只问不改。',
    writeResult: '已写入 0 项，跳过 0 项',
    undo: '本轮没有可撤销的写入',
    nextStep: '可以继续追问，或运行下一项任务。'
  }, 'zh');

  assert.equal(structured.conclusion, '没有发现缺失 citation key，也没有修改文件。');
  assert.match(structured.body, /检查范围：\n- main\.tex\n- references\.bib/);
  assert.match(structured.body, /发现：\n- 4 个 citation key/);
  // The body must NOT include the meta-field labels (those live in `meta`).
  assert.doesNotMatch(structured.body, /未修改原因|写入结果|可撤销|下一步/);

  const keys = structured.meta.map(row => row.key);
  assert.deepEqual(keys, ['unchangedReason', 'writeResult', 'undo', 'nextStep']);
  const byKey = Object.fromEntries(structured.meta.map(row => [row.key, row]));
  assert.equal(byKey.unchangedReason.label, '未修改原因');
  assert.equal(byKey.unchangedReason.value, '这轮是只问不改。');
  assert.equal(byKey.writeResult.label, '写入结果');
  assert.equal(byKey.undo.label, '可撤销');
  assert.equal(byKey.nextStep.label, '下一步');
});

test('buildStructuredHumanReport omits empty fields (no zero-value meta rows)', () => {
  const structured = buildStructuredHumanReport({
    conclusion: '没有发现问题。',
    unchangedReason: '',
    writeResult: '',
    undo: '',
    nextStep: ''
  }, 'zh');

  assert.equal(structured.conclusion, '没有发现问题。');
  assert.equal(structured.body, '');
  assert.deepEqual(structured.meta, []);
});

test('buildStructuredHumanReport English labels match the legacy text format', () => {
  const structured = buildStructuredHumanReport({
    conclusion: 'No file was overwritten.',
    writeResult: 'wrote 0 items, skipped 0 items',
    undo: 'this run has no reversible writes',
    nextStep: 'You can continue the conversation, or adjust @context and run again.'
  }, 'en');

  assert.equal(structured.conclusion, 'No file was overwritten.');
  const labels = structured.meta.map(row => row.label);
  assert.deepEqual(labels, ['Write result', 'Undo', 'Next']);
});

test('buildHumanCompletionReport attaches structured payload alongside text', () => {
  // includeWriteResult + undoCount drive the same auto-fill paths the real
  // run pipeline uses (writeResult populated from applyResults counts; undo
  // populated from the run-record undo count).
  const report = buildHumanCompletionReport({
    locale: 'zh',
    status: 'completed',
    userReport: {
      conclusion: '没有发现缺失 citation key。',
      nextStep: '可以继续追问。'
    },
    applyResults: [{ applied: [], skipped: [] }],
    includeWriteResult: true,
    undoCount: 0
  });

  assert.equal(typeof report.text, 'string');
  assert.match(report.text, /结论：没有发现缺失 citation key。/);

  assert.ok(report.structured, 'structured payload must be attached');
  assert.equal(report.structured.conclusion, '没有发现缺失 citation key。');
  // writeResult (auto-filled) + undo (auto-filled from undoCount: 0) + nextStep.
  const keys = report.structured.meta.map(row => row.key);
  assert.deepEqual(keys, ['writeResult', 'undo', 'nextStep']);
});

// ---------------------------------------------------------------------------
// translateRawError codexReturned context: when an unrelated exception
// escapes runCodexTask's outer catch AFTER Codex has already produced an
// assistantMessage, the user sees Codex's answer in the chat — the fallback
// must NOT claim 'local Codex returned no usable result' (the misleading
// pre-fix copy that surfaced for hundreds of users when the v1.3.8 write-
// guard's null-operation crash escaped the catch). Caller passes
// codexReturned: Boolean(getAssistantAnswerForCurrentRun()).
// ---------------------------------------------------------------------------

test('translateRawError surfaces post-processing failure when Codex did return a result', () => {
  const translated = translateRawError('TypeError: cannot read property fooBar of undefined', {
    mode: 'auto',
    locale: 'zh',
    codexReturned: true
  });

  assert.match(translated.conclusion, /Codex 已经返回了结果/, 'must acknowledge Codex did return');
  assert.match(translated.nextStep, /Codex 的回答仍保留在会话中/, 'must reassure the user the answer is preserved');
  // The misleading legacy copy must NOT appear when codexReturned is true.
  assert.doesNotMatch(translated.conclusion, /没有返回可用结果|did not finish normally/);
});

test('translateRawError English copy mirrors the codexReturned post-processing branch', () => {
  const translated = translateRawError('Some unrecognised crash', {
    mode: 'auto',
    locale: 'en',
    codexReturned: true
  });

  assert.match(translated.conclusion, /Codex returned a result, but local post-processing/);
  assert.match(translated.nextStep, /Codex's answer is preserved in the conversation/);
  assert.doesNotMatch(translated.conclusion, /returned no usable result/);
});

test('translateRawError keeps the original "no usable result" copy when Codex did not return', () => {
  const translated = translateRawError('Some unrecognised crash', {
    mode: 'auto',
    locale: 'en'
    // codexReturned omitted → falsy
  });

  assert.match(translated.conclusion, /returned no usable result/);
  // Negative path also covers ask mode default copy unchanged.
  const askMode = translateRawError('Some unrecognised crash', { mode: 'ask', locale: 'en' });
  assert.match(askMode.conclusion, /did not finish normally/);
});

// ---------------------------------------------------------------------------
// translateRawError → FailureReason catalog mapping. Each branch returns a
// `failureCode` from the 47-code catalog (or null when no direct map exists)
// so callers can attach a structured failure event alongside the existing
// user-visible text. Pre-fix, classification was duplicated between the
// regex branches here and the structured FailureReason emissions in the
// content-side runtime.
// ---------------------------------------------------------------------------

test('translateRawError surfaces failureCode for known catalog codes', () => {
  // 1:1 catalog mappings — these MUST be present so the run-record carries
  // machine-readable failure data.
  assert.equal(translateRawError('Codex CLI was not found locally (ENOENT)', {}).failureCode, 'codex_not_found');
  assert.equal(translateRawError('Codex app-server timed out after 600000ms', {}).failureCode, 'codex_timeout');
  assert.equal(translateRawError('Codex stdout output limit exceeded', {}).failureCode, 'codex_output_limit');
  assert.equal(translateRawError('Agent returned invalid JSON', {}).failureCode, 'codex_result_parse_failed');
  assert.equal(translateRawError('Could not parse Codex output', {}).failureCode, 'codex_result_parse_failed');
  assert.equal(translateRawError('Resource::kQuotaBytes quota exceeded', {}).failureCode, 'storage_quota_exceeded');
  assert.equal(translateRawError('project_locked: currently in use by codex.run', {}).failureCode, 'codex_project_locked');
  assert.equal(translateRawError('changed while Codex was working', {}).failureCode, 'stale_source_changed');
  assert.equal(translateRawError('Unsupported parameter: reasoning.summary', {}).failureCode, 'native_protocol_incompatible');
});

test('translateRawError leaves failureCode null for branches without a catalog match', () => {
  // Preflight / governance — no current code maps cleanly.
  assert.equal(translateRawError('Mode must be "confirm" or "auto"', {}).failureCode, null);
  // Auto-mode checkpoint preflight failure — also no current code.
  assert.equal(translateRawError('checkpoint version unavailable', {}).failureCode, null);
  // codexReturned post-processing branch — the real underlying error already
  // attached its own structured failure earlier in the run.
  assert.equal(translateRawError('Some crash', { codexReturned: true }).failureCode, null);
});

test('translateRawError default branch (unrecognised error, codex did not return) emits codex_no_usable_result', () => {
  const translated = translateRawError('Some unrecognised crash', { mode: 'auto' });
  assert.equal(translated.failureCode, 'codex_no_usable_result');
});
