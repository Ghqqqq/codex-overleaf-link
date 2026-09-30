(function initSubagentActivityView(root, factory) {
  root.CodexOverleafModuleRegistry.define('SubagentActivityView', ['SubagentActivityModel', 'RunActivityModel'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function subagentActivityViewFactory(Agents, Activity) {
  'use strict';
  function create(deps) {
    const { tx, getPanel, plain, make, icon, formatElapsed, renderBlocks } = deps;
    let viewer = null;
    function statusLabel(status) {
      return ({ pending: tx('Starting', '启动中'), running: tx('Running', '运行中'),
        completed: tx('Completed', '已完成'), failed: tx('Failed', '失败'),
        cancelled: tx('Stopped', '已停止'), unknown: tx('Status unconfirmed', '状态未确认') })[status] || '';
    }
    function latest(agent) {
      const blocks = Activity.project({ status: agent.status, events: agent.events || [] }).blocks;
      const last = blocks.at(-1);
      const item = last?.kind === 'exploreGroup' ? last.items.at(-1) : last;
      return plain(item?.meta?.target || item?.meta?.command || item?.event?.title || agent.task).slice(0, 180);
    }
    function elapsed(agent) {
      const start = Date.parse(agent.startedAt || ''), end = Date.parse(agent.finishedAt || '');
      return Number.isFinite(start) ? formatElapsed(Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start)) : '';
    }
    function close() {
      if (!viewer) return;
      const previous = viewer; viewer = null;
      previous.shell.remove();
      for (const [node, inert] of previous.inert) if (node.isConnected) node.inert = inert;
      if (previous.log?.isConnected) previous.log.scrollTop = previous.parentScroll;
      if (previous.trigger?.isConnected) previous.trigger.focus({ preventScroll: true });
    }
    function open(card, key, trigger) {
      const agent = card.run.subagents?.find(item => item.key === key);
      const panel = getPanel();
      if (!agent || !panel) return;
      if (viewer?.card.id === card.id) {
        viewer.scrolls.set(viewer.key, viewer.body.scrollTop);
        viewer.key = key; viewer.rows.clear(); viewer.events.replaceChildren(); renderViewer(card); return;
      }
      close();
      const shell = make('section', 'codex-subagent-view');
      shell.setAttribute('role', 'region');
      shell.setAttribute('aria-label', tx('Subagent conversation', '子代理对话'));
      const header = make('header', 'codex-subagent-view-head');
      const back = make('button', 'codex-subagent-back');
      back.type = 'button'; back.textContent = tx('Back to main task', '返回主任务');
      back.addEventListener('click', close);
      const readonly = make('span', 'codex-subagent-readonly'); readonly.textContent = tx('Read only', '只读');
      header.append(back, readonly);
      const parent = make('div', 'codex-subagent-parent');
      const parentLabel = make('span', 'codex-subagent-parent-label');
      const parentCount = make('span', 'codex-subagent-parent-count');
      parent.append(parentLabel, parentCount);
      const siblings = make('nav', 'codex-subagent-siblings'); siblings.setAttribute('aria-label', tx('Subagents', '子代理'));
      const body = make('div', 'codex-subagent-body');
      const title = make('h3', 'codex-subagent-title');
      const meta = make('div', 'codex-subagent-meta');
      const assignment = make('details', 'codex-subagent-assignment');
      const assignmentLabel = make('summary', ''); assignmentLabel.textContent = tx('Assigned task', '派遣任务');
      const prompt = make('p', ''); assignment.append(assignmentLabel, prompt);
      const events = make('div', 'run-workflow-list');
      events.dataset.expanded = 'true';
      const empty = make('p', 'codex-subagent-empty');
      const limit = make('p', 'codex-subagent-history-note');
      const bottom = make('button', 'codex-subagent-latest'); bottom.type = 'button';
      bottom.textContent = tx('Latest activity', '最新活动'); bottom.hidden = true;
      bottom.addEventListener('click', () => { body.scrollTop = body.scrollHeight; });
      body.append(title, meta, assignment, events, empty, limit);
      const footer = make('footer', 'codex-subagent-footer');
      footer.textContent = tx('Continue the conversation in the main task.', '后续对话在主任务中继续。');
      shell.append(header, parent, siblings, body, bottom, footer);
      const log = panel.querySelector('[data-log]');
      const inert = Array.from(panel.children).map(node => [node, node.inert]);
      for (const [node] of inert) node.inert = true;
      panel.append(shell);
      viewer = { shell, card, key, trigger, log, parentScroll: log?.scrollTop || 0, inert,
        title, meta, assignment, prompt, parentLabel, parentCount, siblings, body, events, empty, limit, bottom,
        rows: new Map(), siblingRows: new Map(), scrolls: new Map(), renderedKey: '' };
      body.addEventListener('scroll', () => {
        if (viewer?.shell === shell) bottom.hidden = body.scrollHeight - body.scrollTop - body.clientHeight < 70;
      }, { passive: true });
      shell.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
      renderViewer(card); back.focus({ preventScroll: true });
    }
    function mount(card) {
      const el = make('section', 'run-subagents');
      const heading = make('div', 'run-subagents-heading');
      const label = make('span', ''); label.textContent = tx('Subagents', '子代理');
      const count = make('span', 'run-subagents-count'); count.setAttribute('aria-live', 'polite');
      heading.append(icon('agent'), label, count);
      const rows = make('div', 'run-subagents-rows'); el.append(heading, rows);
      card.events.before(el);
      card.subagentGroup = { el, count, rows, cache: new Map() };
    }
    function update(card) {
      if (!card.subagentGroup) mount(card);
      const agents = card.run.subagents || [], group = card.subagentGroup;
      group.el.hidden = agents.length === 0;
      const running = agents.filter(agent => ['pending', 'running'].includes(Agents.effectiveStatus(agent, card.run))).length;
      const completed = agents.filter(agent => Agents.effectiveStatus(agent, card.run) === 'completed').length;
      const failed = agents.filter(agent => Agents.effectiveStatus(agent, card.run) === 'failed').length;
      group.count.textContent = [
        running ? tx(running + ' active', running + ' 进行中') : '',
        completed ? tx(completed + ' completed', completed + ' 已完成') : '',
        failed ? tx(failed + ' failed', failed + ' 失败') : ''
      ].filter(Boolean).join(' · ') || tx(agents.length + ' recorded', agents.length + ' 项记录');
      const keep = new Set();
      for (const agent of agents) {
        keep.add(agent.key);
        let row = group.cache.get(agent.key);
        if (!row) {
          const el = make('button', 'run-subagent-row'); el.type = 'button';
          const mark = icon('agent'), copy = make('span', 'run-subagent-copy');
          const name = make('span', 'run-subagent-name'), activity = make('span', 'run-subagent-activity');
          copy.append(name, activity);
          const tail = make('span', 'run-subagent-tail'), status = make('span', ''), time = make('span', 'run-subagent-time');
          tail.append(status, time);
          el.append(mark, copy, tail);
          el.addEventListener('click', () => open(card, agent.key, el));
          row = { el, name, activity, status, time }; group.cache.set(agent.key, row); group.rows.append(el);
        }
        const status = Agents.effectiveStatus(agent, card.run);
        row.el.dataset.state = status;
        row.name.textContent = plain(agent.title || agent.jobId || agent.threadId);
        row.activity.textContent = latest(agent) || statusLabel(status);
        row.activity.title = row.activity.textContent;
        row.status.textContent = statusLabel(status); row.time.textContent = elapsed(agent);
        row.el.setAttribute('aria-label', row.name.textContent + ', ' + statusLabel(status) + ', ' + tx('Open conversation', '查看子对话'));
      }
      for (const [key, row] of group.cache) if (!keep.has(key)) { row.el.remove(); group.cache.delete(key); }
      if (viewer?.card.id === card.id) renderViewer(card);
    }
    function renderViewer(card) {
      try {
        renderViewerContent(card);
        if (viewer) viewer.renderError = false;
      } catch (error) {
        // A read-only child view must not interrupt the parent event or settlement path.
        if (!viewer) return;
        if (!viewer.renderError) console.warn('[codex-overleaf] Child conversation render failed:', plain(error?.message));
        viewer.renderError = true;
        viewer.rows.clear(); viewer.events.replaceChildren();
        viewer.empty.hidden = false;
        viewer.empty.textContent = tx('Unable to display this subagent conversation. Return to the main task and reopen it.',
          '暂时无法显示子代理对话，请返回主任务后重新打开。');
      }
    }
    function renderViewerContent(card) {
      if (!viewer || !viewer.shell.isConnected) { if (viewer) close(); return; }
      const agent = card.run.subagents?.find(item => item.key === viewer.key);
      if (!agent) { close(); return; }
      viewer.card = card;
      const switched = viewer.renderedKey !== agent.key;
      const follow = !switched && viewer.body.scrollHeight - viewer.body.scrollTop - viewer.body.clientHeight < 70;
      const childStatus = Agents.effectiveStatus(agent, card.run);
      viewer.title.textContent = plain(agent.title || agent.jobId || agent.threadId);
      viewer.meta.textContent = [statusLabel(childStatus), elapsed(agent), agent.model, agent.reasoningEffort].filter(Boolean).join(' · ');
      viewer.prompt.textContent = plain(agent.task);
      viewer.assignment.hidden = !viewer.prompt.textContent;
      const parent = Activity.project(card.run), last = parent.blocks.at(-1);
      const lastItem = last?.kind === 'exploreGroup' ? last.items.at(-1) : last;
      const parentWork = plain(lastItem?.meta?.target || lastItem?.meta?.command || lastItem?.event?.title).slice(0, 150);
      viewer.parentLabel.textContent = tx('Main agent · ', '主 agent · ') + (card.run.status === 'running'
        ? parentWork || tx('Working', '处理中') : tx('Run ended', '本轮已结束'));
      const running = (card.run.subagents || []).filter(item => ['pending', 'running'].includes(Agents.effectiveStatus(item, card.run))).length;
      viewer.parentCount.textContent = tx(running + ' subagents active', running + ' 个子任务进行中');
      for (const sibling of card.run.subagents || []) {
        let button = viewer.siblingRows.get(sibling.key);
        if (!button) {
          button = make('button', 'codex-subagent-sibling'); button.type = 'button';
          button.addEventListener('click', () => open(viewer.card, sibling.key, viewer.trigger));
          viewer.siblingRows.set(sibling.key, button); viewer.siblings.append(button);
        }
        button.textContent = plain(sibling.title || sibling.jobId || sibling.threadId);
        button.setAttribute('aria-pressed', String(sibling.key === agent.key));
        button.title = statusLabel(Agents.effectiveStatus(sibling, card.run));
      }
      const childRun = { id: card.id + ':' + agent.key, status: ['pending', 'running'].includes(childStatus) ? 'running' : childStatus,
        events: agent.events || [], mode: 'ask' };
      const result = Activity.project(childRun);
      const childCard = { id: childRun.id, projection: result };
      renderBlocks(viewer.events, result.blocks, viewer.rows, childCard, childRun);
      viewer.empty.hidden = result.blocks.length > 0;
      viewer.empty.textContent = agent.historyUnavailable
        ? tx('This runtime could not read the child history. Recorded updates remain available.', '当前运行端无法读取子会话历史，已记录的活动仍会保留。')
        : tx('Waiting for recorded activity from this subagent.', '等待该子代理的活动记录。');
      viewer.limit.hidden = !agent.clipped;
      viewer.limit.textContent = tx('Older details were trimmed to keep history bounded.', '较早的详细记录已按历史容量上限裁剪。');
      if (switched) viewer.body.scrollTop = viewer.scrolls.get(agent.key) || 0;
      else if (follow) viewer.body.scrollTop = viewer.body.scrollHeight;
      viewer.renderedKey = agent.key;
    }
    return { update, close, isOpen: () => Boolean(viewer?.shell.isConnected) };
  }
  return { create };
});
