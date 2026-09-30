(function initCodexOverleafRunActivitySummary() {
  'use strict';

  function create(deps = {}) {
    if (!deps.RunActivityModel) return null;
    const { RunActivityModel: Model, tx, findRunRecord, getPanel, cssEscape, isGuidance,
      formatElapsed, renderMarkdownBlockText, renderRunEvent,
      sanitizeAssistantVisibleText: sanitize = value => String(value || '') } = deps;
    const cards = new WeakMap();
    const choices = new Map();
    const storageKey = 'codex-overleaf:workflow-disclosure:v1';
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) for (const entry of saved.slice(-200)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') choices.set(entry[0], entry[1]);
      }
    } catch { /* Presentation preferences must not affect run storage. */ }

    const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
    const plain = value => String(sanitize(value) || '').trim();
    const make = (tag, className) => {
      const node = document.createElement(tag);
      node.className = className;
      return node;
    };
    const subagentView = deps.SubagentActivityView?.create({
      tx, getPanel, plain, make, icon, formatElapsed,
      renderBlocks: (parent, blocks, rows, card, run) => reconcile(parent, blocks, rows,
        block => buildBlock(block, card), (row, block) => updateBlock(row, block, card, run))
    });
    function remember(key, open) {
      choices.delete(key);
      choices.set(key, open);
      if (choices.size > 200) choices.delete(choices.keys().next().value);
      try { window.sessionStorage.setItem(storageKey, JSON.stringify([...choices])); } catch { /* Optional. */ }
    }
    function disclosure(details, key) {
      const summary = details.querySelector('summary');
      if (choices.has(key)) details.open = choices.get(key);
      summary.addEventListener('click', () => remember(key, !details.open));
      details.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(details.open)));
      summary.setAttribute('aria-expanded', String(details.open));
    }
    function resolve(view) {
      let root = view?.root || view?.events?.closest('[data-run-id]');
      const id = view?.recordId || root?.dataset.runId;
      if (root?.isConnected === false && id) root = getPanel?.()?.querySelector('[data-run-id="' + cssEscape(id) + '"]') || root;
      return { root, run: id ? findRunRecord?.(id, view?.sessionId) : null };
    }
    function icon(kind) {
      const node = make('span', 'run-workflow-icon');
      node.setAttribute('aria-hidden', 'true');
      const glyphs = { exploreGroup: 'search', explore: 'search', edit: 'file', command: 'terminal', compile: 'terminal', sync: 'sync', notice: 'notice', agent: 'agent', plan: 'plan', tool: 'tool' };
      const paths = {
        search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
        file: '<path d="M9 2H4v12h8V5L9 2Z M9 2v4h3 M6 9h4 M6 11h3"/>',
        terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m5 6 2 2-2 2 M9 10h2"/>',
        sync: '<path d="M3 6a5 5 0 0 1 8-3l2 2 M13 2v3h-3 M13 10a5 5 0 0 1-8 3l-2-2 M3 14v-3h3"/>',
        notice: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5v4 M8 11h.01"/>',
        agent: '<circle cx="8" cy="5" r="2.5"/><path d="M3 14v-2a5 5 0 0 1 10 0v2"/>',
        plan: '<path d="m2 4 1 1 2-2 M7 4h7 M2 8h3 M7 8h7 M2 12h3 M7 12h7"/>',
        tool: '<path d="m3 3 10 10 M10 3l3 3 M11 2l3 3 M2 11l3 3 M3 10l3 3"/>'
      };
      node.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + paths[glyphs[kind] || 'tool'] + '</svg>';
      return node;
    }
    function effectiveState(item, run) {
      const state = item.meta?.state || 'info';
      if (!['running', 'pending'].includes(state) || run.status === 'running') return state;
      return ['cancelled', 'rejected', 'interrupted', 'abandoned_after_navigation'].includes(run.status) ? 'cancelled' : 'unknown';
    }
    function stateLabel(state) {
      return ({
        running: tx('In progress', '进行中'), pending: tx('Pending', '等待中'),
        completed: tx('Completed', '已完成'), failed: tx('Failed', '失败'),
        warning: tx('Needs attention', '需留意'), cancelled: tx('Stopped', '已停止'),
        skipped: tx('Skipped', '已跳过'), triggered: tx('Triggered; awaiting result', '已触发，待结果'),
        unknown: tx('Result unconfirmed', '结果未确认'), info: ''
      })[state] || '';
    }
    function kindLabel(item) {
      if (item.kind === 'edit' && item.file) return ({ add: tx('Create locally', '本地新建'), delete: tx('Delete locally', '本地删除'), move: tx('Move locally', '本地移动') })[item.file.operation] || tx('Edit locally', '本地修改');
      if (item.kind === 'explore') return ({ read: tx('Read', '读取'), search: tx('Search', '搜索'), list: tx('List', '查看目录') })[item.meta.action] || tx('Explore', '查阅');
      return ({ command: tx('Run', '执行'), edit: tx('Edit locally', '本地修改'), sync: tx('Sync to Overleaf', '同步到 Overleaf'),
        compile: tx('Overleaf compile', 'Overleaf 编译'), tool: tx('Tool', '工具'),
        agent: tx('Subagent', '子代理'), plan: tx('Plan', '计划'), notice: tx('Notice', '提示') })[item.kind] || tx('Activity', '活动');
    }
    function targetText(item) {
      const meta = item.meta || {};
      if (item.file) return item.file.path;
      if (item.kind === 'sync' && meta.written !== undefined) {
        return tx(meta.written + ' written' + (meta.skipped ? ', ' + meta.skipped + ' skipped' : ''),
          '已写入 ' + meta.written + ' 项' + (meta.skipped ? '，跳过 ' + meta.skipped + ' 项' : ''));
      }
      if (meta.target) return meta.target;
      if (meta.paths?.length) return meta.paths.join(', ');
      if (meta.command) return meta.command.replace(/\s+/g, ' ');
      return plain(item.event?.title);
    }

    function makeTool(item, card) {
      const el = make('details', 'run-workflow-tool run-work-block');
      el.dataset.kind = item.kind;
      const summary = make('summary', 'run-workflow-tool-summary');
      const label = make('span', 'run-workflow-tool-kind');
      const target = make('span', 'run-workflow-tool-target');
      const status = make('span', 'run-workflow-tool-state');
      const diff = make('span', 'run-workflow-diff-count');
      const arrow = make('span', 'run-workflow-chevron');
      arrow.setAttribute('aria-hidden', 'true');
      summary.append(icon(item.kind), label, target, diff, status, arrow);
      const body = make('div', 'run-workflow-tool-body');
      el.append(summary, body);
      const key = card.id + ':tool:' + item.key;
      disclosure(el, key);
      return { el, label, target, status, diff, body, key, bodyStamp: '' };
    }
    function renderTool(row, item, card, run) {
      const meta = item.meta || {};
      const state = effectiveState(item, run);
      row.el.dataset.state = state;
      text(row.label, kindLabel(item));
      text(row.target, targetText(item));
      row.target.title = targetText(item);
      let status = stateLabel(state);
      if (state === 'running' && item.kind === 'compile') {
        const start = Date.parse(item.startedAt || '');
        if (Number.isFinite(start)) status += ' ' + formatElapsed(Math.max(0, Date.now() - start));
      }
      text(row.status, status);
      const file = item.file;
      const showDiff = state === 'completed' && file && file.added !== undefined && file.removed !== undefined;
      row.diff.hidden = !showDiff;
      if (showDiff) {
        if (!row.diff.firstChild) {
          row.diff.append(make('span', 'run-workflow-added'), make('span', 'run-workflow-removed'));
        }
        text(row.diff.firstChild, '+' + file.added);
        text(row.diff.lastChild, '-' + file.removed);
        row.status.hidden = true;
      } else row.status.hidden = false;
      const publicText = plain(item.event?.title);
      const stamp = [publicText, meta.output, meta.command, meta.exitCode, file?.preview, state, meta.clipped].join('\0');
      if (stamp !== row.bodyStamp) {
        row.bodyStamp = stamp;
        row.body.replaceChildren();
        if (file?.preview) {
          const diffBody = make('pre', 'run-workflow-patch');
          for (const line of file.preview.split('\n')) {
            const lineNode = make('span', line.startsWith('+') && !line.startsWith('+++') ? 'is-added' : line.startsWith('-') && !line.startsWith('---') ? 'is-removed' : '');
            lineNode.textContent = line + '\n';
            diffBody.append(lineNode);
          }
          row.body.append(diffBody);
        } else {
          if (meta.command) { const command = make('pre', 'run-workflow-command'); command.textContent = plain(meta.command); row.body.append(command); }
          if (meta.output) { const output = make('pre', 'run-workflow-output'); output.textContent = plain(meta.output); row.body.append(output); }
          const note = make('div', 'run-workflow-tool-note');
          note.textContent = publicText;
          row.body.append(note);
        }
        if (meta.exitCode !== undefined) { const exit = make('div', 'run-workflow-tool-note'); exit.textContent = tx('Exit code: ', '退出码：') + meta.exitCode; row.body.append(exit); }
        if (meta.clipped || file?.clipped) { const more = make('div', 'run-workflow-tool-note'); more.textContent = tx('Preview only. More detail may be available in diagnostics.', '当前为摘要预览，更多信息可通过诊断查看。'); row.body.append(more); }
      }
      if (!choices.has(row.key)) row.el.open = card.projection.notices.some(notice => notice.key === item.key);
    }
    function reconcile(parent, entries, cache, build, updateRow) {
      const keep = new Set();
      let cursor = parent.firstChild;
      for (const entry of entries) {
        keep.add(entry.key);
        let row = cache.get(entry.key);
        if (!row) { row = build(entry); cache.set(entry.key, row); }
        updateRow(row, entry);
        if (row.el !== cursor) parent.insertBefore(row.el, cursor);
        cursor = row.el.nextSibling;
      }
      for (const [key, row] of cache) if (!keep.has(key)) { row.el.remove(); cache.delete(key); }
    }
    function buildBlock(block, card) {
      if (block.kind === 'message' || block.kind === 'guidance') {
        const el = make('div', 'run-work-block run-workflow-' + block.kind + (block.kind === 'message' ? ' run-stream-text' : ''));
        el.dataset.kind = block.kind;
        return { el, stamp: '' };
      }
      const row = makeTool(block, card);
      if (block.kind === 'exploreGroup') row.children = new Map();
      return row;
    }
    function updateBlock(row, block, card, run) {
      if (block.kind === 'message') {
        const value = String(sanitize(block.event.title) || '');
        const streaming = run.status === 'running' && block.event.status === 'running';
        const stamp = String(streaming) + ':' + value;
        if (row.stamp !== stamp) { row.stamp = stamp; renderMarkdownBlockText(row.el, value, { streaming }); }
        row.el.dataset.streaming = String(streaming);
        return;
      }
      if (block.kind === 'guidance') {
        const stamp = [block.event.title, block.event.status, block.event.guidanceId].join('\0');
        if (row.stamp !== stamp) { row.stamp = stamp; row.el.replaceChildren(renderRunEvent(block.event)); }
        return;
      }
      if (block.kind !== 'exploreGroup') { renderTool(row, block, card, run); return; }
      const items = block.items;
      const last = items.at(-1);
      if (items.length === 1) {
        if (row.grouped) { row.children.clear(); row.bodyStamp = ''; }
        row.grouped = false;
        renderTool(row, last, card, run);
        return;
      }
      if (!row.grouped) { row.body.replaceChildren(); row.children.clear(); row.grouped = true; }
      const states = items.map(item => effectiveState(item, run));
      const groupState = states.includes('failed') ? 'failed' : states.includes('warning') ? 'warning'
        : states.includes('running') ? 'running' : states.includes('unknown') ? 'unknown'
          : states.includes('cancelled') ? 'cancelled' : states.every(state => state === 'completed') ? 'completed' : 'info';
      row.el.dataset.state = groupState;
      text(row.label, items.length === 1 ? kindLabel(last) : tx('Explore', '查阅与搜索'));
      const paths = [...new Set(items.flatMap(item => item.meta.paths || []))];
      text(row.target, items.length === 1 ? targetText(last)
        : tx(items.length + ' operations', items.length + ' 项操作') + (paths.length ? ' · ' + paths.join(', ') : ''));
      row.target.title = row.target.textContent;
      text(row.status, stateLabel(groupState));
      row.diff.hidden = true;
      reconcile(row.body, items, row.children, item => makeTool(item, card),
        (child, item) => renderTool(child, item, card, run));
      if (!choices.has(row.key)) row.el.open = items.some(item => card.projection.notices.some(notice => notice.key === item.key));
    }

    function mount(root, run) {
      if (!Model || cards.has(root)) return;
      const process = root.querySelector('[data-run-process]');
      const summary = root.querySelector('[data-run-process-summary]');
      const events = root.querySelector('[data-run-events]');
      if (!process || !summary || !events) return;
      root.classList.add('run-presentation-workflow');
      events.classList.add('run-workflow-list');
      events.replaceChildren();
      const metrics = make('span', 'run-workflow-metrics');
      summary.append(metrics);
      const attention = make('button', 'run-workflow-attention');
      attention.type = 'button';
      attention.hidden = true;
      attention.addEventListener('click', () => { remember(String(run.id) + ':run', true); process.open = true; update({ root, recordId: run.id }); });
      process.before(attention);
      const busy = make('div', 'run-workflow-busy');
      busy.setAttribute('role', 'status');
      events.after(busy);
      const card = { id: String(run.id), root, process, summary, events, metrics, attention,
        busy, rows: new Map(), run };
      cards.set(root, card);
      disclosure(process, card.id + ':run');
      process.addEventListener('toggle', () => {
        events.dataset.expanded = String(process.open);
        card.attention.hidden = process.open || !card.noticeCount;
      });
      render(card, run);
    }
    function render(card, run, incoming) {
      card.run = run;
      const result = Model.project(run, incoming, { isGuidance });
      card.projection = result;
      subagentView?.update(card);
      const active = run.status === 'running';
      const abnormal = ['failed', 'interrupted', 'needs_review_after_navigation', 'abandoned_after_navigation'].includes(run.status);
      if (choices.has(card.id + ':run')) card.process.open = choices.get(card.id + ':run');
      else card.process.open = active || abnormal;
      card.events.dataset.expanded = String(card.process.open);
      card.summary.setAttribute('aria-expanded', String(card.process.open));
      reconcile(card.events, result.blocks, card.rows, block => buildBlock(block, card),
        (row, block) => updateBlock(row, block, card, run));
      card.noticeCount = result.notices.length;
      const latestNotice = result.notices.at(-1);
      card.attention.hidden = card.process.open || !latestNotice;
      text(card.attention, latestNotice ? plain(latestNotice.event.title) : '');
      card.metrics.hidden = active || !result.fileCount;
      text(card.metrics, (result.clipped ? tx('Recorded: ', '已记录：') : '')
        + tx(result.fileCount + ' local files changed', result.fileCount + ' 个本地文件有改动'));
      const hasActive = result.blocks.some(block => block.kind === 'message' && block.event.status === 'running'
        || block.kind === 'exploreGroup' && block.items.some(item => item.meta.state === 'running')
        || block.meta?.state === 'running');
      card.busy.hidden = !active || hasActive;
      text(card.busy, result.stage === 'local_completed'
        ? (run.mode === 'ask' ? tx('Preparing the answer…', '正在整理回答…') : tx('Preparing writeback and verification…', '正在准备写回与验证…'))
        : result.stage === 'preparing' ? tx('Preparing project context…', '正在准备项目上下文…') : tx('Working…', '正在处理…'));
    }
    function update(view, incoming) {
      const { root, run } = resolve(view);
      const card = root && cards.get(root);
      if (!card || !run) return false;
      const status = view?.terminalStatus || run.status || root.dataset.status;
      render(card, status === run.status ? run : { ...run, status }, incoming);
      return true;
    }
    function settle(view, statusText) {
      update(view);
      const { root } = resolve(view);
      text(view?.status || root?.querySelector('[data-run-status]'), statusText);
    }
    function appendDetail(view, row, event) {
      if (!update(view, event)) view.events?.append(row);
    }
    return { mount, update, settle, appendDetail,
      closeSubagentView: () => subagentView?.close(),
      isSubagentViewOpen: () => subagentView?.isOpen() || false };
  }

  window.CodexOverleafRunActivitySummary = { create };
})();
