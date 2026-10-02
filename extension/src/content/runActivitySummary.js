(function initCodexOverleafRunActivitySummary() {
  'use strict';

  function create(deps = {}) {
    if (!deps.RunActivityModel) return null;
    const { RunActivityModel: Model, tx, findRunRecord, getPanel, cssEscape, isGuidance,
      formatElapsed, renderMarkdownBlockText, renderRunEvent, presence, classifyStatus, getProjectId, summarizeCommand,
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
      if (meta.command) return summarizeCommand?.(meta.command) || meta.command.replace(/\s+/g, ' ');
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
    // Reasoning (CoT): the live one streams its last lines; settled ones fold to one line and open to the full text.
    function makeThought(block, card) {
      const el = make('details', 'run-work-block run-workflow-thought');
      el.dataset.kind = 'thought';
      const summary = make('summary', 'run-workflow-thought-line');
      const label = make('span', 'run-workflow-thought-label');
      const lead = make('span', 'run-workflow-thought-lead');
      summary.append(label, lead);
      const tail = make('div', 'run-workflow-thought-tail');
      tail.append(make('span', ''));
      const full = make('div', 'run-workflow-thought-full');
      el.append(summary, tail, full);
      const key = card.id + ':thought:' + block.key;
      disclosure(el, key);
      const row = { el, key, label, lead, tail, full, stamp: '', value: '', rendered: null, live: false };
      // Full text renders only when opened; long CoT stays cheap in collapsed history.
      row.showFull = () => {
        if (row.live || !el.open || row.rendered === row.value) return;
        row.rendered = row.value;
        renderMarkdownBlockText(full, row.value, { streaming: false });
      };
      el.addEventListener('toggle', row.showFull);
      return row;
    }
    function updateThought(row, block, run) {
      const value = String(sanitize(block.event.title) || '').trim();
      const live = run.status === 'running' && block.event.status === 'running';
      const stamp = String(live) + ':' + value;
      if (row.stamp === stamp) return;
      row.stamp = stamp;
      row.el.dataset.live = String(live);
      row.live = live;
      // A closed <details> hides everything but its summary, so the live tail needs the row open.
      if (live) { row.el.open = true; text(row.tail.firstChild, value.slice(-900)); return; }
      if (!choices.has(row.key)) row.el.open = false;
      const started = Date.parse(block.startedAt || ''), ended = Date.parse(block.event.timestamp || '');
      const seconds = Number.isFinite(started) && Number.isFinite(ended) && ended > started ? formatElapsed(ended - started) : '';
      text(row.label, seconds ? tx('Thought ' + seconds, '思考 ' + seconds) : tx('Thought', '思考'));
      const flat = value.replace(/\s+/g, ' ');
      text(row.lead, (flat.match(/^.{12,160}?[.!?。！？](?=\s|$)/) || [flat.slice(0, 160)])[0]);
      row.value = value;
      row.showFull();
    }
    // Start-up block: what happens between Send and the model's first response, step by step.
    const SETUP_CALM_MS = 30000;
    function setupStepText(entry, live) {
      const n = entry.count;
      const copy = {
        editing: live ? tx('Checking Overleaf editing mode', '检查 Overleaf 编辑模式')
          : entry.reviewing ? tx('Overleaf Track Changes is on', 'Overleaf 已开启留痕') : tx('Overleaf is in Editing mode', 'Overleaf 处于编辑模式'),
        read: live ? tx('Reading the Overleaf project', '正在读取 Overleaf 项目')
          : n ? tx('Read the Overleaf project · ' + n + ' text files', '已读取 Overleaf 项目 · ' + n + ' 个文本文件') : tx('Read the Overleaf project', '已读取 Overleaf 项目'),
        warm: tx('Using the already synced workspace', '使用已同步的工作区，无需重新读取项目'),
        workspace: live ? tx('Writing the local workspace', '正在写入本地工作区')
          : n ? tx('Synced ' + n + ' files to the local workspace', '已同步 ' + n + ' 个文件到本地工作区') : tx('Synced the local workspace', '已同步本地工作区'),
        codex: live ? tx('Starting Codex', '正在启动 Codex')
          : entry.version ? tx('Started Codex CLI ' + entry.version, '已启动 Codex CLI ' + entry.version) : tx('Started Codex', '已启动 Codex'),
        waiting: live ? tx("Waiting for the model's first response", '等待模型首次响应') : tx('The model responded', '模型已开始响应')
      };
      return copy[entry.step] || '';
    }
    function setupNote(note) {
      const empty = /^(\d+) file\(s\) have empty\/loading content\.$/.exec(note);
      if (empty) return tx(empty[1] + ' file(s) are empty or still loading', empty[1] + ' 个文件内容为空或尚未加载完');
      const short = /^(\d+) captured file\(s\) are shorter than 80 characters\.$/.exec(note);
      if (short) return tx(short[1] + ' file(s) are very short and may not have loaded', short[1] + ' 个文件内容很短，可能没有加载完');
      return note;
    }
    function setupLiveLabel(setup) {
      const live = setup.steps.findLast(entry => entry.state === 'running');
      return live ? setupStepText(live, true) : tx('Starting the task', '正在启动任务');
    }
    function renderSetup(card, setup, active) {
      const el = card.setup;
      const steps = setup?.steps || [];
      el.hidden = !steps.length && !active;
      if (el.hidden) return;
      const folded = setup.done || !active;
      el.dataset.folded = String(folded);
      el.dataset.live = String(active && !setup.done);
      const first = Date.parse(steps[0]?.at || ''), waitAt = Date.parse(steps.find(entry => entry.step === 'waiting')?.at || '');
      const parts = [Number.isFinite(first) && Number.isFinite(waitAt) && waitAt >= first
        ? tx('Setup ' + formatElapsed(waitAt - first), '启动 ' + formatElapsed(waitAt - first)) : tx('Setup', '启动')];
      const files = steps.find(entry => entry.step === 'workspace')?.count;
      if (files) parts.push(tx(files + ' files', files + ' 个文件'));
      else if (steps.some(entry => entry.step === 'warm')) parts.push(tx('synced workspace', '已同步的工作区'));
      const version = steps.find(entry => entry.version)?.version;
      if (version) parts.push('Codex ' + version);
      text(card.setupFold, parts.join(' · '));
      card.setupSummary.dataset.notes = String(steps.some(entry => entry.notes?.length));
      const rows = steps.length ? steps : [{ step: 'start', state: 'running', at: '' }];
      while (card.setupSteps.children.length > rows.length) card.setupSteps.lastChild.remove();
      rows.forEach((entry, index) => {
        let row = card.setupSteps.children[index];
        if (!row) {
          row = make('div', 'run-setup-step');
          row.append(make('span', 'run-setup-glyph'), make('span', 'run-setup-text'), make('span', 'run-setup-time'));
          card.setupSteps.append(row);
        }
        const live = active && entry.state === 'running';
        const warn = Boolean(entry.notes?.length);
        row.dataset.state = live ? 'running' : warn ? 'warning' : 'completed';
        const glyph = row.children[0];
        const glyphKind = live ? 'spinner' : warn ? 'notice' : 'check';
        if (glyph.dataset.kind !== glyphKind) {
          glyph.dataset.kind = glyphKind;
          glyph.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + ({
            spinner: '<circle cx="8" cy="8" r="5.5" opacity=".25"/><path d="M13.5 8A5.5 5.5 0 0 0 8 2.5"/>',
            notice: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5v4 M8 11h.01"/>', check: '<path d="m3.5 8 3 3 6-6"/>' })[glyphKind] + '</svg>';
        }
        const label = entry.step === 'start' ? tx('Starting the task', '正在启动任务') : setupStepText(entry, live);
        const body = row.children[1];
        const extras = [...(entry.notes || []).map(note => ['run-setup-note', setupNote(note)])];
        const started = Date.parse(entry.at || ''), ended = Date.parse(entry.endAt || '');
        const elapsed = Number.isFinite(started) ? Math.max(0, (live ? Date.now() : (Number.isFinite(ended) ? ended : started)) - started) : NaN;
        if (live && entry.step === 'waiting' && elapsed > SETUP_CALM_MS) {
          extras.push(['run-setup-calm', tx('The model is thinking. With some third-party providers, its reasoning arrives all at once when this step ends.',
            '模型正在思考。部分第三方服务的思考内容会在这一段结束后一起显示。')]);
        }
        const stamp = label + '\0' + extras.map(pair => pair.join(':')).join('\0');
        if (body.dataset.stamp !== stamp) {
          body.dataset.stamp = stamp;
          const main = make('span', 'run-setup-label');
          main.textContent = label + (live ? '…' : '');
          body.replaceChildren(main);
          for (const [className, value] of extras) { const line = make('span', className); line.textContent = value; body.append(line); }
        }
        text(row.children[2], Number.isFinite(elapsed) && (live || elapsed >= 1000) ? formatElapsed(elapsed) : '');
      });
    }
    // Collapsed live peek: a three-row window onto the newest start-up step, thought or tool call.
    // Prose stays out of it; new rows enter at the bottom and push older ones up.
    const PEEK_ROWS = 3;
    const PEEK_GLYPHS = {
      spinner: '<circle cx="8" cy="8" r="5.5" opacity=".25"/><path d="M13.5 8A5.5 5.5 0 0 0 8 2.5"/>',
      check: '<path d="m3.5 8 3 3 6-6"/>', notice: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5v4 M8 11h.01"/>',
      fail: '<path d="m4 4 8 8M12 4l-8 8"/>'
    };
    function firstSentence(value) {
      const flat = String(value || '').replace(/\s+/g, ' ').trim();
      return (flat.match(/^.{12,160}?[.!?。！？](?=\s|$)/) || [flat.slice(0, 160)])[0];
    }
    function peekToolResult(item, state) {
      if (state === 'running' || state === 'pending') return '';
      if (['failed', 'warning', 'cancelled', 'unknown', 'skipped'].includes(state)) return stateLabel(state);
      if (item.file && item.file.added !== undefined) return '+' + item.file.added + ' −' + item.file.removed;
      const found = /found (\d+) relevant line|找到 (\d+) 处/.exec(plain(item.event?.title));
      const count = found && Number(found[1] || found[2]);
      return count ? tx(count + (count === 1 ? ' match' : ' matches'), count + ' 处匹配') : '';
    }
    function peekEntries(card, result, run) {
      const entries = [];
      const setup = result.setup || { steps: [] };
      if (!setup.done) {
        const steps = setup.steps.length ? setup.steps : [{ step: 'start', state: 'running' }];
        steps.forEach((entry, index) => {
          const live = entry.state === 'running';
          const started = Date.parse(entry.at || ''), ended = Date.parse(entry.endAt || '');
          const elapsed = Number.isFinite(started) ? Math.max(0, (live ? Date.now() : (Number.isFinite(ended) ? ended : started)) - started) : NaN;
          entries.push({ key: 'setup:' + index, kind: 'setup', glyph: live ? 'spinner' : entry.notes?.length ? 'notice' : 'check',
            state: live ? 'running' : entry.notes?.length ? 'warning' : 'completed',
            lead: (entry.step === 'start' ? tx('Starting the task', '正在启动任务') : setupStepText(entry, live)) + (live ? '…' : ''),
            result: entry.notes?.length ? setupNote(entry.notes[0]) : Number.isFinite(elapsed) && (live || elapsed >= 1000) ? formatElapsed(elapsed) : '' });
        });
        return entries;
      }
      if (setup.steps.length) entries.push({ key: 'setup:fold', kind: 'setup', glyph: 'check', state: 'completed', lead: card.setupFold.textContent });
      for (const block of result.blocks) {
        if (block.kind === 'thought') {
          const value = String(sanitize(block.event.title) || '').trim();
          const live = run.status === 'running' && block.event.status === 'running';
          const started = Date.parse(block.startedAt || ''), ended = Date.parse(block.event.timestamp || '');
          const seconds = Number.isFinite(started) && Number.isFinite(ended) && ended > started ? ' ' + formatElapsed(ended - started) : '';
          const flat = value.replace(/\s+/g, ' ');
          entries.push({ key: block.key, kind: 'thought', state: live ? 'running' : 'completed',
            label: live ? tx('Thinking', '思考中') : tx('Thought', '思考') + seconds,
            lead: live ? (flat.length > 90 ? '…' + flat.slice(-90) : flat) : firstSentence(value) });
        } else if (block.kind !== 'message' && block.kind !== 'guidance') {
          for (const item of block.kind === 'exploreGroup' ? block.items : [block]) {
            if (item.kind === 'notice') continue;
            const state = effectiveState(item, run);
            entries.push({ key: item.key + (item.file ? ':' + item.file.path : ''), kind: 'tool', state, toolKind: item.kind,
              glyph: state === 'running' ? 'spinner' : state === 'failed' ? 'fail' : '',
              label: kindLabel(item), target: targetText(item), result: peekToolResult(item, state) });
          }
        }
      }
      return entries;
    }
    function renderPeek(card, result, run, active) {
      const show = active && !card.process.open;
      card.peek.hidden = !show;
      card.peekMore.hidden = true;
      if (!show) return;
      const entries = peekEntries(card, result, run);
      const recent = entries.slice(-PEEK_ROWS);
      const keep = new Set(recent.map(entry => entry.key));
      for (const [key, row] of card.peekRows) if (!keep.has(key)) { row.el.remove(); card.peekRows.delete(key); }
      let cursor = card.peekTrack.firstChild;
      for (const entry of recent) {
        let row = card.peekRows.get(entry.key);
        if (!row) {
          const el = make('div', 'run-peek-row is-entering');
          row = { el, glyph: make('span', 'run-peek-glyph'), label: make('span', 'run-peek-label'), lead: make('span', 'run-peek-lead'),
            result: make('span', 'run-peek-result') };
          el.append(row.glyph, row.label, row.lead, row.result);
          card.peekRows.set(entry.key, row);
        } else if (row.el.className !== 'run-peek-row') {
          row.el.className = 'run-peek-row'; // the slide-in plays once, on the render that created the row
        }
        // Touch the DOM only when the order changes: re-inserting a node restarts its CSS animation,
        // which made the rows jump on every one-second timer tick.
        if (row.el !== cursor) card.peekTrack.insertBefore(row.el, cursor);
        cursor = row.el.nextSibling;
        row.el.dataset.kind = entry.kind;
        row.el.dataset.state = entry.state;
        const glyph = entry.kind === 'tool' && !entry.glyph ? 'tool:' + entry.toolKind : entry.glyph || 'dot';
        if (row.glyphKind !== glyph) {
          row.glyphKind = glyph;
          row.glyph.replaceChildren();
          if (glyph.startsWith('tool:')) row.glyph.append(icon(entry.toolKind));
          else if (glyph !== 'dot') row.glyph.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + PEEK_GLYPHS[glyph] + '</svg>';
        }
        text(row.label, entry.label || '');
        text(row.lead, entry.kind === 'tool' ? entry.target : entry.lead);
        text(row.result, entry.result ? (entry.kind === 'tool' ? '⎿ ' : '') + entry.result : '');
      }
      const hidden = entries.length - recent.length;
      // The window grows with its rows (1→3) so a fresh run has no empty band; the top fade only appears once rows scroll out.
      card.peek.dataset.rows = String(recent.length);
      card.peek.dataset.overflow = String(hidden > 0);
      card.peekMore.hidden = hidden <= 0;
      text(card.peekMore, tx(hidden + (hidden === 1 ? ' earlier step' : ' earlier steps') + ' · expand to see all', '之前还有 ' + hidden + ' 步 · 展开查看全部'));
    }
    function buildBlock(block, card) {
      if (block.kind === 'thought') return makeThought(block, card);
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
      if (block.kind === 'thought') { updateThought(row, block, run); return; }
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
      const setupEl = make('details', 'run-setup');
      const setupSummary = make('summary', 'run-setup-summary');
      const setupFold = make('span', 'run-setup-fold');
      setupSummary.append(make('span', 'run-setup-done'), setupFold);
      const setupSteps = make('div', 'run-setup-steps');
      setupEl.append(setupSummary, setupSteps);
      setupEl.hidden = true;
      events.before(setupEl);
      const peek = make('div', 'run-peek');
      peek.setAttribute('aria-hidden', 'true');
      const peekTrack = make('div', 'run-peek-track');
      peek.append(peekTrack);
      peek.hidden = true;
      const peekMore = make('button', 'run-peek-more');
      peekMore.type = 'button';
      peekMore.hidden = true;
      setupEl.before(peek);
      setupEl.before(peekMore);
      const busy = make('div', 'run-workflow-busy');
      busy.setAttribute('role', 'status');
      events.after(busy);
      const card = { id: String(run.id), root, process, summary, events, metrics, attention,
        busy, rows: new Map(), run, setup: setupEl, setupSummary, setupFold, setupSteps,
        peek, peekTrack, peekMore, peekRows: new Map() };
      const expand = () => { remember(card.id + ':run', true); process.open = true; update({ root, recordId: run.id }); };
      peek.addEventListener('click', expand);
      peekMore.addEventListener('click', expand);
      disclosure(setupEl, String(run.id) + ':setup');
      cards.set(root, card);
      disclosure(process, card.id + ':run');
      process.addEventListener('toggle', () => {
        events.dataset.expanded = String(process.open);
        card.attention.hidden = process.open || !card.noticeCount;
        if (card.projection) {
          renderSetup(card, card.projection.setup, card.run.status === 'running');
          if (!process.open) card.setup.hidden = true;
          renderPeek(card, card.projection, card.run, card.run.status === 'running');
        }
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
      // A live run starts collapsed onto its peek window; problems open it.
      else card.process.open = abnormal;
      card.events.dataset.expanded = String(card.process.open);
      card.summary.setAttribute('aria-expanded', String(card.process.open));
      reconcile(card.events, result.blocks, card.rows, block => buildBlock(block, card),
        (row, block) => updateBlock(row, block, card, run));
      renderSetup(card, result.setup, active);
      // Live start-up stays open; once work begins (or in history) it follows the run disclosure.
      if (active && !result.setup?.done) card.setup.open = true;
      else if (!choices.has(card.id + ':setup')) card.setup.open = false;
      if (!card.process.open) card.setup.hidden = true;
      renderPeek(card, result, run, active);
      card.noticeCount = result.notices.length;
      const latestNotice = result.notices.at(-1);
      card.attention.hidden = card.process.open || !latestNotice;
      text(card.attention, latestNotice ? plain(latestNotice.event.title) : '');
      paintPresence(card, run, result, active);
      // The ∎ header carries the file count (and its recorded-only caveat) whenever presence is on.
      card.metrics.hidden = active || !result.fileCount || Boolean(presence);
      text(card.metrics, (result.clipped ? tx('Recorded: ', '已记录：') : '')
        + tx(result.fileCount + ' local files changed', result.fileCount + ' 个本地文件有改动'));
      const hasActive = result.blocks.some(block => block.kind === 'message' && block.event.status === 'running'
        || block.kind === 'exploreGroup' && block.items.some(item => item.meta.state === 'running')
        || block.meta?.state === 'running');
      // The presence header already narrates the live state.
      card.busy.hidden = !active || hasActive || Boolean(presence);
      text(card.busy, result.stage === 'local_completed'
        ? (run.mode === 'ask' ? tx('Preparing the answer…', '正在整理回答…') : tx('Preparing writeback and verification…', '正在准备写回与验证…'))
        : result.stage === 'preparing' ? tx('Preparing project context…', '正在准备项目上下文…') : tx('Working…', '正在处理…'));
    }
    // Live header: long phases are named; otherwise a rarely-changing word. Tool steps stay in the round list.
    function runningLabel(result, run) {
      if (result.stage === 'sync') return { kind: 'stage', text: tx('Syncing changes to Overleaf', '正在同步改动到 Overleaf') };
      // Before the model's first response the header names the real start-up step, not a playful word.
      if (result.setup && !result.setup.done) return { kind: 'stage', text: setupLiveLabel(result.setup) };
      if (result.stage === 'preparing') return { kind: 'stage', text: tx('Preparing project context', '正在准备项目上下文') };
      if (result.stage === 'local_completed') {
        return { kind: 'stage', text: run.mode === 'ask' ? tx('Preparing the answer', '正在整理回答')
          : tx('Preparing writeback and verification', '正在准备写回与验证') };
      }
      return { kind: 'idle' };
    }
    function paintPresence(card, run, result, active) {
      const status = card.root.querySelector('[data-run-status]');
      if (!presence || !status) return;
      // History cards arrive with plain status text; keep it for failure and fallback labels.
      if (!status.dataset.presence && !status.dataset.presenceText) status.dataset.presenceText = status.textContent;
      const started = Date.parse(run.startedAt || '');
      if (active) {
        presence.paintRunning(status, { runId: card.id, label: runningLabel(result, run),
          elapsedMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined });
        return;
      }
      const finished = Date.parse(run.finishedAt || '');
      const facts = { kind: classifyStatus?.(run) || 'plain', text: status.dataset.presenceText || status.textContent,
        elapsedMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null,
        files: result.fileCount, filesClipped: result.clipped === true, added: 0, removed: 0, steps: 0, compiled: false,
        projectId: getProjectId?.() || '', animate: card.animateNext === true };
      card.animateNext = false;
      for (const block of result.blocks) {
        if (['message', 'guidance', 'thought'].includes(block.kind)) continue;
        facts.steps += block.kind === 'exploreGroup' ? block.items.length : 1;
        if (block.file && block.meta?.state === 'completed') {
          facts.added += block.file.added || 0;
          facts.removed += block.file.removed || 0;
        }
        if (block.kind === 'compile' && block.meta?.state === 'completed') facts.compiled = true;
      }
      presence.paintSettled(status, facts);
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
      const { root } = resolve(view);
      const card = root && cards.get(root);
      const status = view?.status || root?.querySelector('[data-run-status]');
      if (presence && card && status) {
        status.dataset.presenceText = statusText;
        card.animateNext = true;
        if (update(view)) return;
      }
      update(view);
      text(status, statusText);
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
