(function initChangeHistoryView(root, factory) {
  root.CodexOverleafModuleRegistry.define('ChangeHistoryView', ['ChangeHistoryModel'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function changeHistoryViewFactory(Model) {
  'use strict';
  function create(deps) {
    const { tx, StorageDb, getState, getCurrentProjectId, getAccountScopeId,
      getSettingsPanelInstance, onHistoryRowJump, sanitizeText } = deps;
    let generation = 0, owner = null, records = [], storedSessions = [], limit = 8, loading = false, error = '';
    const container = () => getSettingsPanelInstance()?.container;
    const make = (tag, className, text) => {
      const element = document.createElement(tag); element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    function icon(kind) {
      const node = make('span', 'codex-history-icon');
      node.setAttribute('aria-hidden', 'true');
      const paths = {
        file: '<path d="M9 2H4v12h8V5L9 2Z M9 2v4h3 M6 9h4 M6 11h3"/>',
        message: '<path d="M3 3h10v8H7l-4 3V3Z M5 6h6 M5 8h4"/>',
        arrow: '<path d="M4 12 12 4 M5 4h7v7"/>'
      };
      node.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + paths[kind] + '</svg>';
      return node;
    }
    function label(state) {
      return ({
        pending: tx('Pending review', '待接受'), accepted: tx('Accepted', '已接受'),
        undone: tx('Undone', '已撤销'), attention: tx('Needs attention', '需检查'),
        written: tx('Written', '已写入'), running: tx('In progress', '进行中'),
        unchanged: tx('No file changes', '未修改文件'), unknown: tx('Status unavailable', '状态不可用')
      })[state] || '';
    }
    function title(row) {
      if (row.summary) return row.summary;
      if (!row.hasWrites) return tx('Task without file changes', '未修改文件的任务');
      if (row.status === 'attention') return row.paths.length === 1
        ? tx('Check changes to ', '检查文件修改：') + row.paths[0] : tx('File changes need attention', '文件修改需要检查');
      if (row.paths.length === 1) {
        const verbs = { create: ['Created ', '新建 '], 'binary-create': ['Created ', '新建 '],
          delete: ['Deleted ', '删除 '], move: ['Moved ', '移动 '], rename: ['Renamed ', '重命名 '] };
        const verb = verbs[row.operation] || ['Updated ', '修改 '];
        return tx(verb[0], verb[1]) + row.paths[0];
      }
      return row.paths.length ? tx('Changed ' + row.paths.length + ' files', '修改 ' + row.paths.length + ' 个文件')
        : tx('Project file changes', '项目文件修改');
    }
    function when(value) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return tx('Time unavailable', '时间不可用');
      const locale = getState()?.locale === 'zh' ? 'zh-CN' : 'en';
      const now = new Date(), yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
      const day = date.toDateString() === now.toDateString() ? tx('Today', '今天')
        : date.toDateString() === yesterday.toDateString() ? tx('Yesterday', '昨天')
          : date.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
      return day + ' ' + date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    function current(snapshot) {
      return snapshot && snapshot.projectId === getCurrentProjectId()
        && snapshot.accountScopeId === getAccountScopeId?.() && snapshot.container === container();
    }
    function message(list, content, retry = false) {
      const empty = make('div', 'codex-history-empty', content);
      if (retry) {
        const button = make('button', 'codex-history-jump', tx('Try again', '重试'));
        button.type = 'button'; button.addEventListener('click', load); empty.append(button);
      }
      list.replaceChildren(empty);
    }
    function render() {
      const host = container(), list = host?.querySelector('[data-history-list]');
      if (!list) return;
      const search = host.querySelector('[data-history-filter]');
      search.placeholder = tx('Search files or summaries', '搜索文件或修改摘要');
      search.setAttribute('aria-label', search.placeholder);
      const count = host.querySelector('[data-history-count]');
      const toggle = host.querySelector('[data-history-include-empty]');
      const includeLabel = host.querySelector('[data-history-include-label]');
      const more = host.querySelector('[data-history-more]');
      if (count) count.textContent = '';
      if (more) more.hidden = true;
      if (loading || error || !current(owner)) {
        if (toggle?.parentElement) toggle.parentElement.hidden = true;
        message(list, loading ? tx('Loading file changes…', '正在读取文件修改记录…')
          : error || tx('Open this project again to load its history.', '重新打开本项目以读取历史记录。'), Boolean(error));
        return;
      }
      const state = getState();
      const projected = Model.project(records, {
        projectId: owner.projectId, accountScopeId: owner.accountScopeId,
        storedSessions, sessions: state.sessions, activeSessionId: state.activeSessionId, activeRuns: state.runs,
        sanitizeText
      });
      const query = search.value.trim().toLowerCase();
      const selected = host.querySelector('[data-history-status]')?.value || 'all';
      const rows = projected.filter(row => (toggle?.checked || row.hasWrites)
        && (selected === 'all' || row.status === selected)
        && (!query || [title(row), ...row.paths].join(' ').toLowerCase().includes(query)));
      if (count) count.textContent = tx(rows.length + ' records', rows.length + ' 条');
      const noWrites = projected.filter(row => !row.hasWrites).length;
      if (toggle?.parentElement) toggle.parentElement.hidden = noWrites === 0;
      if (includeLabel) includeLabel.textContent = tx('Include ' + noWrites + ' tasks without file changes', '同时显示 ' + noWrites + ' 条未修改文件的任务');
      list.replaceChildren();
      if (!rows.length) {
        message(list, query || selected !== 'all'
          ? tx('No matching file changes. Try another file name or status.', '没有匹配的修改记录，可尝试其他文件名或状态。')
          : tx('No file changes recorded for this project yet.', '本项目还没有已记录的文件修改。'));
      }
      for (const row of rows.slice(0, limit)) {
        const element = make('article', 'codex-history-row');
        element.dataset.resultStatus = row.status;
        const mark = make('span', 'codex-history-mark'); mark.append(icon(row.hasWrites ? 'file' : 'message'));
        const body = make('div', 'codex-history-copy'), top = make('div', 'codex-history-top');
        const name = make('div', 'codex-history-task', title(row));
        const status = make('span', 'codex-history-status', label(row.status)); status.dataset.state = row.status;
        top.append(name, status);
        const files = make('div', 'codex-history-files', row.paths.length ? row.paths.join(' · ')
          : row.hasWrites ? tx('Detailed file names are no longer available.', '详细文件名已不可用。')
            : tx('No files were written to Overleaf.', '没有向 Overleaf 写入文件。'));
        const footer = make('div', 'codex-history-bottom');
        const fileCount = row.paths.length ? tx(' · ' + row.paths.length + ' file(s)', ' · ' + row.paths.length + ' 个文件') : '';
        footer.append(make('time', 'codex-history-when', when(row.createdAt) + fileCount));
        const jump = make('button', 'codex-history-jump');
        jump.type = 'button'; jump.disabled = !row.canJump;
        jump.append(make('span', '', row.canJump ? tx('View conversation', '查看对应对话') : tx('Conversation unavailable', '对话不可用')));
        if (row.canJump) jump.append(icon('arrow'));
        jump.title = row.canJump ? tx('Open the original run', '定位到对应轮次')
          : tx('The original run is no longer in the loaded conversation history.', '原轮次已不在当前可用的对话历史中。');
        jump.setAttribute('aria-label', jump.textContent + ': ' + title(row));
        const snapshot = owner;
        jump.addEventListener('click', () => {
          if (current(snapshot)) void onHistoryRowJump?.(row);
        });
        footer.append(jump); body.append(top, files, footer); element.append(mark, body); list.append(element);
      }
      if (more) {
        more.hidden = rows.length <= limit;
        more.textContent = tx('Show more (' + Math.min(8, rows.length - limit) + ')', '再显示 ' + Math.min(8, rows.length - limit) + ' 条');
        more.onclick = () => { limit += 8; render(); };
      }
    }
    async function load() {
      const host = container();
      if (!host?.querySelector('[data-history-list]')) return;
      const requestId = ++generation;
      owner = { projectId: getCurrentProjectId(), accountScopeId: getAccountScopeId?.() || '', container: host };
      const snapshot = owner;
      records = []; storedSessions = []; limit = 8; error = '';
      if (!snapshot.accountScopeId || !snapshot.projectId) {
        loading = false; error = tx('Project identity is unavailable. Reopen the project to load its history.', '暂时无法确认项目身份，请重新打开项目后查看历史。'); render(); return;
      }
      loading = true; render();
      let timer;
      try {
        const data = await Promise.race([
          Promise.all([
            StorageDb.getAllByIndex('auditLogs', 'projectId', snapshot.projectId),
            StorageDb.getAllByIndex('sessions', 'projectId', snapshot.projectId)
          ]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('history_load_timeout')), 3000); })
        ]);
        if (requestId !== generation || !current(snapshot)) return;
        [records, storedSessions] = data;
        loading = false; render();
      } catch (_) {
        if (requestId !== generation || !current(snapshot)) return;
        loading = false; error = tx('File changes could not be loaded.', '暂时无法读取文件修改记录。'); render();
      } finally { clearTimeout(timer); }
    }
    return { load, filter() { limit = 8; render(); }, invalidate() {
      generation += 1; records = []; storedSessions = []; owner = null; loading = false; error = '';
    } };
  }
  return { create };
});
