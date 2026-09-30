(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/writingStyle'));
  else root.CodexOverleafModuleRegistry.define('WritingStyleSettings', ['WritingStyle'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';
  const CHANGE_KEY = 'codex-overleaf-writing-style-changed-v1';
  const LIMITS = Shared.REFERENCE_LIMITS;
  const MAX_SOURCES = LIMITS.maxSources;

  function create(deps) {
    let scopeKey = '', scope = null, epoch = 0, meta = null, loadPromise = null;
    let host = null, sources = [], sourceSnapshot = null, observer = null;
    let desiredEnabled = false, setupEnabled = null, expanded = false, dirty = false;
    let message = '', messageTone = '', toggleBusy = false, pollTimer = null;
    let projects = [], projectLoaded = false, projectLoading = false, projectError = '';
    let pickerOpen = false, query = '', filter = 'all';
    let activeGeneration = null, cancelling = false;
    let preview = null, previewBusy = false, previewFile = 'references/writing-style.md';
    const tx = (en, zh) => deps.tx(en, zh);
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    function button(label, action, className = 'ws2-button', key) {
      const element = node('button', className, label);
      element.type = 'button';
      if (key) element.dataset.styleFocus = key;
      element.addEventListener('click', action);
      return element;
    }
    function icon(name) {
      const paths = {
        book: ['M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z', 'M13 7a3 3 0 0 1 3-3h4v15h-4a4 4 0 0 0-3 2'],
        project: ['M4 6h6l2 2h8v11H4z', 'M8 12h8', 'M8 15h5'],
        pdf: ['M6 3h8l4 4v14H6z', 'M14 3v5h4', 'M9 12h6', 'M9 16h4'],
        plus: ['M12 5v14', 'M5 12h14'],
        search: ['M20 20l-5-5', 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0'],
        refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M5.5 8a7 7 0 0 1 11.8-3L20 8', 'M4 16l2.7 3A7 7 0 0 0 18.5 16'],
        close: ['M6 6l12 12', 'M18 6L6 18'],
        arrow: ['M5 12h14', 'M14 7l5 5-5 5'],
        check: ['M5 12l4 4L19 6']
      };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
      for (const value of paths[name] || paths.book) {
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', value); svg.append(path);
      }
      return svg;
    }
    function iconButton(name, label, action, key) {
      const element = button('', action, 'ws2-icon-button', key);
      element.title = label; element.setAttribute('aria-label', label); element.append(icon(name));
      return element;
    }
    function currentScope() {
      const value = deps.getScope();
      return value?.accountScopeId && value?.projectId ? value : null;
    }
    function alignScope() {
      const next = currentScope(), key = next ? next.accountScopeId + ':' + next.projectId : '';
      if (scopeKey !== key) {
        const previous = activeGeneration;
        if (previous && previous.phase === 'reading') {
          previous.cancelled = true;
          if (previous.readId) void deps.cancelReferenceRead(previous.readId).catch(() => {});
        }
        scopeKey = key; scope = next; epoch++;
        meta = null; loadPromise = null; sources = []; sourceSnapshot = null;
        projects = []; projectLoaded = false; projectLoading = false; projectError = '';
        desiredEnabled = false; setupEnabled = null; expanded = false; dirty = false;
        message = ''; messageTone = ''; toggleBusy = false; pickerOpen = false; query = ''; filter = 'all';
        activeGeneration = null; cancelling = false; preview = null; previewBusy = false;
        clearTimeout(pollTimer); pollTimer = null;
      }
      return scope;
    }
    async function request(method, params = {}) {
      const response = await deps.request({ method, params });
      if (!response?.ok) {
        const error = new Error(response?.error?.message || tx('The request could not be completed.', '请求未能完成。'));
        error.code = response?.error?.code || 'writing_style_failed'; throw error;
      }
      return response.result;
    }
    function restoreSources(value) {
      sources = (value.sources || []).map(source => source.kind === 'project'
        ? { kind: 'project', projectId: source.projectId, name: source.name, capturedAt: source.capturedAt }
        : { kind: 'saved', sourceId: source.id, name: source.name });
      sourceSnapshot = value.snapshot || null;
    }
    async function ensureLoaded(fresh = false) {
      const target = alignScope();
      if (!target) return null;
      if (loadPromise) return loadPromise;
      if (meta && !fresh) return meta;
      const generation = epoch;
      loadPromise = request('writing-style.get', target).then(value => {
        if (generation !== epoch) return null;
        meta = value;
        if (setupEnabled === null) desiredEnabled = value.enabled === true;
        if (!dirty && !activeGeneration) restoreSources(value);
        if (value.error && !message) { message = value.error; messageTone = 'error'; }
        clearTimeout(pollTimer); pollTimer = null;
        if (value.building) pollTimer = setTimeout(() => { void ensureLoaded(true).catch(() => {}); }, 1800);
        else if (!activeGeneration) cancelling = false;
        render(); return value;
      }).catch(error => {
        if (generation === epoch) { message = error.message; messageTone = 'error'; render(); }
        throw error;
      }).finally(() => { if (generation === epoch) loadPromise = null; });
      return loadPromise;
    }
    function capture() {
      if (!alignScope()) return null;
      if (!meta) throw new Error(tx('Writing-style settings are loading. Try again shortly.', '写作风格设置正在加载，请稍后再试。'));
      if (!desiredEnabled) return null;
      if (!meta.ready) throw new Error(tx('Finish setting up the writing style in General, or turn it off.', '请在常规设置中完成写作风格设置，或关闭此功能。'));
      return Shared.normalizeSnapshot(meta.snapshot);
    }
    function changed() { dirty = true; preview = null; message = ''; messageTone = ''; render(); }
    async function notify(target) {
      await chrome.storage.local.set({ [CHANGE_KEY]: { ...target, changedAt: Date.now(), nonce: Math.random().toString(36) } });
    }
    function working() { return Boolean(activeGeneration || meta?.building); }
    async function toggle(value) {
      const target = alignScope(), generation = epoch;
      if (!target || toggleBusy) return;
      desiredEnabled = value; expanded = value || expanded; message = ''; messageTone = '';
      if (value && !meta?.ready) {
        setupEnabled = true; pickerOpen = sources.length === 0; render();
        if (pickerOpen) void loadProjects();
        return;
      }
      setupEnabled = null; toggleBusy = true; render();
      try {
        const next = await request('writing-style.set', { ...target, enabled: value });
        if (epoch !== generation) return;
        meta = next; await notify(target);
      } catch (error) {
        if (epoch === generation) { desiredEnabled = meta?.enabled === true; message = error.message; messageTone = 'error'; }
      } finally { if (epoch === generation) { toggleBusy = false; render(); } }
    }
    async function loadProjects(force = false) {
      const target = alignScope(), generation = epoch;
      if (!target || projectLoading || (projectLoaded && !force)) return;
      projectLoading = true; projectError = ''; render();
      try {
        const values = await deps.listProjects(target);
        if (!Array.isArray(values)) throw new Error(tx('The project directory could not be read.', '项目目录未能读取。'));
        if (generation === epoch) { projects = values; projectLoaded = true; }
      } catch (error) {
        if (generation === epoch) { projects = []; projectLoaded = false; projectError = error.message; }
      } finally { if (generation === epoch) { projectLoading = false; render(); } }
    }
    function selectProject(project, selected) {
      if (working()) return;
      const index = sources.findIndex(source => source.kind === 'project' && source.projectId === project.projectId);
      if (!selected && index >= 0) sources.splice(index, 1);
      if (selected && index < 0 && sources.length < MAX_SOURCES) {
        sources.push({ kind: 'project', projectId: project.projectId, name: project.name });
      }
      changed();
    }
    function addFiles(files) {
      if (working()) return;
      message = ''; messageTone = '';
      for (const file of Array.from(files || [])) {
        if (sources.length >= MAX_SOURCES) { message = tx('Three references selected. Remove one to add another.', '已选三份资料，移除一份后可继续添加。'); break; }
        if (!/\.pdf$/i.test(file.name) || file.size > LIMITS.maxPdfBytes || file.size === 0) {
          message = tx('Choose a text-based PDF up to 20 MiB.', '请选择不超过 20 MiB、含文字层的 PDF。'); messageTone = 'error'; break;
        }
        if (sources.some(source => source.file?.name === file.name && source.file?.size === file.size && source.file?.lastModified === file.lastModified)) continue;
        if (sources.reduce((sum, source) => sum + (source.file?.size || 0), file.size) > LIMITS.maxPdfTotalBytes) {
          message = tx('PDFs can total up to 40 MiB.', 'PDF 合计上限为 40 MiB。'); messageTone = 'error'; break;
        }
        sources.push({ kind: 'pdf', id: crypto.randomUUID(), name: file.name, file });
        dirty = true; preview = null;
      }
      render();
    }
    async function encode(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return btoa(binary);
    }
    async function generate() {
      const target = alignScope(), generation = epoch;
      if (!target || working() || deps.isRunning() || !sources.length) return;
      const chosen = sources.map(value => ({ ...value })), reuseSnapshot = sourceSnapshot;
      const operation = { phase: 'reading', cancelled: false, readId: '', requestId: '', generation };
      activeGeneration = operation; cancelling = false; pickerOpen = false; preview = null;
      message = ''; messageTone = ''; expanded = true; render();
      const stillActive = () => {
        if (operation.cancelled || generation !== epoch) {
          const error = new Error(tx('Style generation cancelled.', '已取消风格生成。'));
          error.code = 'codex_cancelled'; throw error;
        }
      };
      try {
        const settings = await deps.getModelSettings();
        stillActive();
        const attachments = [], selected = [];
        for (const source of chosen) {
          stillActive();
          if (source.kind === 'pdf') {
            attachments.push({ id: source.id, name: source.name, size: source.file.size,
              mimeType: 'application/pdf', kind: 'file', contentBase64: await encode(source.file) });
            selected.push({ kind: 'pdf', attachmentId: source.id });
          } else if (source.kind === 'project') {
            operation.readId = crypto.randomUUID(); operation.sourceName = source.name; render();
            const snapshot = await deps.getReferenceSnapshot(source.projectId, operation.readId);
            operation.readId = ''; stillActive();
            if (snapshot?.projectId !== source.projectId || snapshot?.capabilities?.referenceTextComplete !== true) {
              throw new Error(tx('The reference project could not be read completely: ', '参考项目未能完整读取：') + source.name);
            }
            const body = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
            if (body.size > LIMITS.maxProjectBytes) throw new Error(tx('Reference project is too large: ', '参考项目过大：') + source.name);
            const id = crypto.randomUUID();
            attachments.push({ id, name: source.projectId + '.writing-reference.json', size: body.size,
              mimeType: 'application/json', kind: 'file', contentBase64: await encode(body) });
            selected.push({ kind: 'project', projectId: source.projectId, name: source.name, attachmentId: id });
          } else selected.push({ kind: 'saved', sourceId: source.sourceId });
        }
        stillActive();
        operation.phase = 'learning'; operation.sourceName = ''; render();
        const tracked = await deps.startBuild({ ...settings, ...target, mode: 'ask',
          task: 'Generate the selected project writing skill and its section references.',
          attachments, writingStyle: null,
          writingStyleBuild: { enableAfterBuild: desiredEnabled, reuseSnapshot, sources: selected }
        });
        operation.requestId = tracked.id;
        if (operation.cancelled) await request('codex.cancel', { requestId: tracked.id });
        if (generation === epoch) { render(); void ensureLoaded(true).catch(() => {}); }
        const response = await tracked.promise;
        if (generation !== epoch) return;
        if (!response?.ok) {
          const error = new Error(response?.error?.message || tx('Style generation failed.', '风格生成失败。'));
          error.code = response?.error?.code; throw error;
        }
        const result = response.result?.writingStyle;
        if (!result?.ready) throw new Error(tx('No completed writing style was returned.', '未返回完整的写作风格。'));
        meta = result; dirty = false; setupEnabled = null; desiredEnabled = result.enabled === true;
        restoreSources(result);
        message = tx('Writing style is ready.', '写作风格已就绪。'); messageTone = 'success';
        await notify(target);
      } catch (error) {
        if (generation === epoch) {
          message = operation.cancelled || error.code === 'codex_cancelled'
            ? tx('Style generation cancelled.', '已取消风格生成。') : error.message;
          messageTone = operation.cancelled || error.code === 'codex_cancelled' ? '' : 'error';
        }
      } finally {
        if (activeGeneration === operation) {
          activeGeneration = null; cancelling = false;
          await ensureLoaded(true).catch(() => {}); render();
        }
      }
    }
    async function cancel() {
      if (cancelling) return;
      const operation = activeGeneration, generation = epoch;
      const id = operation?.requestId || meta?.building?.requestId;
      if (!operation && !id) return;
      cancelling = true; message = ''; messageTone = '';
      if (operation) operation.cancelled = true;
      render();
      try {
        if (operation?.readId) await deps.cancelReferenceRead(operation.readId);
        if (id) await request('codex.cancel', { requestId: id });
      } catch (error) {
        if (generation === epoch) { cancelling = false; message = error.message; messageTone = 'error'; render(); }
      }
      if (!operation && generation === epoch) await ensureLoaded(true).catch(() => {});
    }
    async function loadPreview() {
      const target = alignScope(), generation = epoch;
      if (!target || previewBusy) return;
      if (preview) { preview = null; render(); return; }
      previewBusy = true; render();
      try {
        const value = await request('writing-style.get', { ...target, includePreview: true });
        if (generation === epoch) { preview = value.preview || []; previewFile = 'references/writing-style.md'; }
      } catch (error) {
        if (generation === epoch) { message = error.message; messageTone = 'error'; }
      } finally { if (generation === epoch) { previewBusy = false; render(); } }
    }
    function displayDate(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(tx('en', 'zh-CN'), { month: 'short', day: 'numeric' });
    }
    function preserveFocus() {
      const active = document.activeElement;
      if (!host?.contains(active) || !active.dataset?.styleFocus) return null;
      return { key: active.dataset.styleFocus, start: active.selectionStart, end: active.selectionEnd };
    }
    function restoreFocus(focus) {
      if (!focus) return;
      const target = host.querySelector('[data-style-focus="' + focus.key + '"]');
      if (!target || target.disabled) return;
      target.focus({ preventScroll: true });
      if (typeof focus.start === 'number' && typeof target.setSelectionRange === 'function') {
        try { target.setSelectionRange(focus.start, focus.end); } catch (_) {}
      }
    }
    function renderPicker() {
      const panel = node('section', 'ws2-picker');
      panel.setAttribute('aria-label', tx('Choose reference projects', '选择参考项目'));
      const heading = node('div', 'ws2-picker-heading');
      heading.append(node('strong', '', tx('Choose projects', '选择项目')));
      const reload = iconButton('refresh', tx('Reload project directory', '刷新项目目录'), () => { void loadProjects(true); }, 'reload-projects');
      reload.disabled = projectLoading;
      heading.append(reload, iconButton('close', tx('Close project picker', '关闭项目选择'), () => { pickerOpen = false; render(); }, 'close-picker'));
      panel.append(heading);
      const search = node('label', 'ws2-search');
      search.append(icon('search'));
      const input = node('input'); input.type = 'search'; input.value = query; input.dataset.styleFocus = 'project-search';
      input.placeholder = tx('Search all Overleaf projects', '搜索全部 Overleaf 项目');
      input.setAttribute('aria-label', input.placeholder);
      input.addEventListener('input', () => { query = input.value; render(); });
      search.append(input); panel.append(search);
      const filters = node('div', 'ws2-filters');
      for (const [value, label] of [['all', tx('All', '全部')], ['active', tx('Active', '常规')], ['archived', tx('Archived', '已归档')]]) {
        const count = value === 'all' ? projects.length : projects.filter(p => p.archived === (value === 'archived')).length;
        const item = button(label + (projectLoaded ? ' ' + count : ''), () => { filter = value; render(); }, 'ws2-filter', 'filter-' + value);
        item.setAttribute('aria-pressed', String(filter === value)); filters.append(item);
      }
      panel.append(filters);
      const list = node('div', 'ws2-projects');
      list.setAttribute('role', 'group'); list.setAttribute('aria-label', tx('Overleaf projects', 'Overleaf 项目'));
      if (projectLoading) {
        const loading = node('div', 'ws2-picker-state');
        loading.append(node('span', 'ws2-pulse'), node('span', '', tx('Loading project directory…', '正在加载项目目录…')));
        list.append(loading);
      } else if (projectError) {
        const error = node('div', 'ws2-picker-state ws2-picker-error');
        error.append(node('strong', '', tx('Projects could not be loaded', '项目列表未能加载')), node('p', '', projectError),
          button(tx('Retry', '重试'), () => { void loadProjects(true); }, 'ws2-button', 'retry-projects'));
        list.append(error);
      } else {
        const searchText = query.trim().toLocaleLowerCase();
        const matches = projects.filter(project => (!searchText || project.name.toLocaleLowerCase().includes(searchText))
          && (filter === 'all' || project.archived === (filter === 'archived')));
        for (const project of matches) {
          const selected = sources.some(source => source.kind === 'project' && source.projectId === project.projectId);
          const row = node('label', 'ws2-project');
          row.dataset.selected = String(selected);
          const checkbox = node('input', 'ws2-check'); checkbox.type = 'checkbox'; checkbox.checked = selected;
          checkbox.dataset.styleFocus = 'project-' + project.projectId;
          checkbox.disabled = working() || (!selected && sources.length >= MAX_SOURCES);
          checkbox.setAttribute('aria-label', project.name);
          checkbox.addEventListener('change', () => selectProject(project, checkbox.checked));
          const copy = node('span', 'ws2-project-copy');
          const title = node('span', 'ws2-project-name', project.name); title.title = project.name;
          copy.append(title);
          const tags = [];
          if (project.projectId === scope?.projectId) tags.push(tx('Current project', '当前项目'));
          if (project.shared) tags.push(tx('Shared', '共享'));
          if (project.archived) tags.push(tx('Archived', '已归档'));
          if (project.readOnly) tags.push(tx('Read only', '只读'));
          if (!tags.length) tags.push(tx('Overleaf project', 'Overleaf 项目'));
          copy.append(node('small', '', tags.join(' · ')));
          row.append(checkbox, copy); list.append(row);
        }
        if (!matches.length) list.append(node('div', 'ws2-picker-state',
          query ? tx('No projects match this search.', '没有匹配的项目。') : tx('No projects in this group.', '此分组暂无项目。')));
      }
      panel.append(list);
      const footer = node('div', 'ws2-picker-footer');
      footer.append(node('span', '', tx(sources.length + ' of 3 references selected', '已选 ' + sources.length + ' / 3 份资料')),
        button(tx('Done', '完成'), () => { pickerOpen = false; render(); }, 'ws2-button ws2-button-primary', 'picker-done'));
      panel.append(footer); return panel;
    }
    function renderSources() {
      const section = node('section', 'ws2-library');
      const heading = node('div', 'ws2-library-heading');
      const title = node('div', 'ws2-label', tx('Reference papers', '参考文稿'));
      title.append(node('span', 'ws2-count', sources.length + ' / 3'));
      heading.append(title);
      const controls = node('div', 'ws2-library-actions');
      const addProjects = button(tx('Projects', '项目'), () => {
        pickerOpen = !pickerOpen; query = ''; filter = 'all'; render();
        if (pickerOpen) { void loadProjects(); host.querySelector('[data-style-focus="project-search"]')?.focus(); }
      }, 'ws2-button ws2-button-quiet', 'add-projects');
      addProjects.prepend(icon('plus')); addProjects.disabled = working();
      addProjects.setAttribute('aria-expanded', String(pickerOpen));
      const input = node('input'); input.type = 'file'; input.accept = '.pdf,application/pdf'; input.multiple = true; input.hidden = true;
      input.addEventListener('change', () => addFiles(input.files));
      const addPdf = button(tx('Add PDF', '添加 PDF'), () => input.click(), 'ws2-button ws2-button-quiet', 'add-pdf');
      addPdf.prepend(icon('plus')); addPdf.disabled = working() || sources.length >= MAX_SOURCES;
      controls.append(addProjects, addPdf, input); heading.append(controls); section.append(heading);
      if (pickerOpen) section.append(renderPicker());
      const list = node('div', 'ws2-source-list');
      if (!sources.length) {
        const empty = node('div', 'ws2-empty');
        const mark = node('div', 'ws2-empty-icon'); mark.append(icon('book'));
        const copy = node('div');
        copy.append(node('strong', '', tx('Start with writing worth learning from', '从值得参考的文稿开始')),
          node('p', '', tx('Choose a project or add a PDF with the style to follow.', '选择项目或添加 PDF，作为写作风格的参考。')));
        empty.append(mark, copy); list.append(empty);
      }
      sources.forEach((source, index) => {
        const row = node('div', 'ws2-source');
        const mark = node('div', 'ws2-source-icon'); mark.append(icon(source.kind === 'project' ? 'project' : 'pdf'));
        const copy = node('div', 'ws2-source-copy'), title = node('strong', '', source.name); title.title = source.name;
        const detail = source.kind === 'project'
          ? (source.projectId === scope?.projectId ? tx('Current project', '当前项目') : tx('Overleaf project', 'Overleaf 项目'))
            + ' · ' + tx('Latest saved text', '最新已保存正文')
          : source.kind === 'saved' ? tx('PDF · Reference saved', 'PDF · 已保存参考')
            : 'PDF · ' + (source.file.size < 1024 * 1024 ? Math.max(1, Math.round(source.file.size / 1024)) + ' KB' : (source.file.size / 1024 / 1024).toFixed(1) + ' MiB');
        copy.append(title, node('small', '', detail));
        const remove = iconButton('close', tx('Remove ', '移除 ') + source.name, () => { sources.splice(index, 1); changed(); }, 'remove-' + index);
        remove.disabled = working(); row.append(mark, copy, remove); list.append(row);
      });
      section.append(list);
      section.append(node('p', 'ws2-caption', tx(
        'Choose up to 3 references. Text-based PDFs: 20 MiB each, 40 MiB total.',
        '最多 3 份参考。PDF 需含文字层，单份 20 MiB、合计 40 MiB。')));
      return section;
    }
    function renderGuide(text) {
      const body = node('div', 'ws2-guide-body');
      for (const block of String(text || '').split(/\n\s*\n/)) {
        if (!block.trim()) continue;
        if (/^#{1,3}\s/.test(block)) body.append(node('h4', '', block.replace(/^#{1,3}\s*/, '')));
        else if (/^(?:[-*]\s|\d+\.\s)/.test(block)) {
          const list = node('ul');
          for (const line of block.split('\n')) list.append(node('li', '', line.replace(/^(?:[-*]\s|\d+\.\s)/, '')));
          body.append(list);
        } else body.append(node('p', '', block));
      }
      return body;
    }
    function renderPreview() {
      const section = node('section', 'ws2-preview');
      const nav = node('div', 'ws2-preview-tabs'); nav.setAttribute('role', 'group');
      nav.setAttribute('aria-label', tx('Generated writing guidance', '生成的写作指导'));
      const files = [{ file: 'references/writing-style.md', title: tx('Overview', '概览') }, ...(meta?.sections || [])];
      for (const item of files) {
        if (!preview.some(value => value.file === item.file)) continue;
        const tab = button(item.title, () => { previewFile = item.file; render(); }, 'ws2-filter');
        tab.setAttribute('aria-pressed', String(previewFile === item.file)); nav.append(tab);
      }
      section.append(nav, renderGuide(preview.find(item => item.file === previewFile)?.content || ''));
      const skill = preview.find(item => item.file === 'SKILL.md');
      if (skill) {
        const details = node('details', 'ws2-skill-source');
        details.append(node('summary', '', tx('Skill instructions', '技能指令')), node('pre', '', skill.content));
        section.append(details);
      }
      return section;
    }
    function render() {
      if (!host?.isConnected) return;
      alignScope();
      const focus = preserveFocus();
      const oldScroll = host.querySelector('.ws2-projects')?.scrollTop || 0;
      const heading = host.closest('[data-set-group]')?.querySelector('[data-writing-style-heading]');
      if (heading) heading.textContent = tx('Writing style', '写作风格');
      host.classList.add('ws2'); host.replaceChildren();
      const top = node('div', 'ws2-heading');
      const copy = node('div', 'ws2-heading-copy');
      const title = node('label', 'ws2-title', tx('Write in My Style', '沿用写作风格'));
      title.htmlFor = 'codex-writing-style-enabled';
      title.append(node('span', 'ws2-beta', tx('Experimental', '实验性')));
      copy.append(title, node('p', 'ws2-description', tx(
        'Learn from selected papers. Bring their voice and structure into the next draft.',
        '学习参考文稿的表达与组织方式，融入后续写作。')));
      const toggleInput = node('input', 'codex-switch');
      toggleInput.type = 'checkbox'; toggleInput.id = 'codex-writing-style-enabled';
      toggleInput.dataset.styleFocus = 'enable-style'; toggleInput.checked = desiredEnabled;
      toggleInput.disabled = !scope || !meta || toggleBusy || (working() && !meta?.ready);
      toggleInput.addEventListener('change', () => { void toggle(toggleInput.checked); });
      top.append(copy, toggleInput); host.append(top);
      if (meta?.ready) {
        const summary = node('div', 'ws2-profile');
        const mark = node('span', 'ws2-profile-icon'); mark.append(icon('check'));
        const info = node('div', 'ws2-profile-copy');
        const label = node('strong', '', meta.label || tx('Project writing style', '项目写作风格'));
        label.title = meta.label || '';
        info.append(label, node('small', '', [
          tx(meta.sources.length + ' references', meta.sources.length + ' 份参考'),
          meta.traits?.length
            ? tx(meta.traits.length + ' style traits', meta.traits.length + ' 项风格特征')
            : tx(meta.sections.length + ' example groups', meta.sections.length + ' 组章节样例'),
          displayDate(meta.createdAt)
        ].filter(Boolean).join(' · ')));
        const view = button(preview ? tx('Hide preview', '收起预览') : tx('Preview style', '预览风格'),
          () => { void loadPreview(); }, 'ws2-button ws2-button-quiet', 'preview-style');
        view.disabled = previewBusy;
        summary.append(mark, info, view); host.append(summary);
      }
      const editing = expanded || working();
      const manage = button(editing ? tx('Hide references', '收起参考资料')
        : meta?.ready ? tx('Manage references', '管理参考资料') : tx('Choose references', '选择参考资料'),
      () => { expanded = !expanded; pickerOpen = false; render(); }, 'ws2-manage', 'manage-references');
      manage.setAttribute('aria-expanded', String(editing));
      manage.disabled = working(); manage.append(icon('arrow')); host.append(manage);
      if (editing) {
        host.append(renderSources());
        if (working()) {
          const progress = node('div', 'ws2-progress'); progress.setAttribute('role', 'status');
          const phase = activeGeneration?.phase || 'learning';
          const headline = cancelling ? tx('Cancelling generation…', '正在取消生成…')
            : phase === 'reading' ? tx('Reading selected references', '正在读取参考资料')
              : tx('Learning the writing style', '正在整理写作风格');
          const line = node('div', 'ws2-progress-title'); line.append(node('span', 'ws2-pulse'), node('strong', '', headline));
          const detail = activeGeneration?.sourceName || (phase === 'learning'
            ? tx('Organizing guidance and section examples.', '整理风格指导与章节示例。')
            : tx('Only selected sources are read.', '仅读取已选资料。'));
          progress.append(line, node('p', '', detail));
          const steps = node('div', 'ws2-steps');
          for (const [index, label] of [tx('Read references', '读取资料'), tx('Learn style', '提炼风格'), tx('Ready', '可使用')].entries()) {
            const step = node('span', '', label); step.dataset.active = String(index <= (phase === 'reading' ? 0 : 1)); steps.append(step);
          }
          progress.append(steps);
          const stop = button(tx('Cancel', '取消'), () => { void cancel(); }, 'ws2-button', 'cancel-generation');
          stop.disabled = cancelling; progress.append(stop); host.append(progress);
        } else {
          const footer = node('div', 'ws2-actions');
          const help = node('div', 'ws2-action-copy');
          help.append(node('span', '', dirty && meta?.ready ? tx('Reference changes are not applied yet', '参考资料变更待生成')
            : tx('Generate once, reuse while writing', '生成一次，后续写作按需参考')));
          help.append(node('small', '', tx('Selected text is sent to the current model.', '选定正文将发送给当前模型。')));
          footer.append(help);
          if (dirty && meta?.ready) footer.append(button(tx('Discard', '撤销选择'), () => {
            restoreSources(meta); dirty = false; message = ''; messageTone = ''; pickerOpen = false; render();
          }, 'ws2-button ws2-button-quiet', 'discard-references'));
          const generateButton = button(meta?.ready ? tx('Update style', '更新风格') : tx('Generate style', '生成风格'),
            () => { void generate(); }, 'ws2-button ws2-button-primary', 'generate-style');
          generateButton.disabled = !scope || !meta || !sources.length || deps.isRunning();
          footer.append(generateButton); host.append(footer);
          if (deps.isRunning()) host.append(node('p', 'ws2-caption', tx('Available after the current task finishes.', '当前任务结束后可生成。')));
        }
      }
      if (message || !meta) {
        const status = node('div', 'ws2-status', message || tx('Loading writing-style settings…', '正在加载写作风格设置…'));
        status.dataset.tone = messageTone;
        status.setAttribute('role', messageTone === 'error' ? 'alert' : 'status');
        if (!meta && message) status.append(button(tx('Retry', '重试'), () => {
          message = ''; messageTone = ''; render(); void ensureLoaded(true).catch(() => {});
        }, 'ws2-button', 'retry-settings'));
        host.append(status);
      }
      if (preview) host.append(renderPreview());
      const scroll = host.querySelector('.ws2-projects');
      if (scroll) scroll.scrollTop = oldScroll;
      restoreFocus(focus);
    }
    function mount(panel) {
      const next = panel?.querySelector('[data-writing-style-settings]');
      if (!next) return;
      host = next;
      if (!observer) {
        observer = new MutationObserver(() => { render(); void ensureLoaded().catch(() => {}); });
        observer.observe(panel, { attributes: true, attributeFilter: ['data-view', 'data-running', 'data-settings-scope'] });
        chrome.storage.onChanged.addListener((changes, area) => {
          const changed = changes[CHANGE_KEY]?.newValue;
          if (area === 'local' && changed && changed.accountScopeId === scope?.accountScopeId && changed.projectId === scope?.projectId) {
            void ensureLoaded(true).catch(() => {});
          }
        });
      }
      render(); void ensureLoaded().catch(() => {});
    }
    function sync() { alignScope(); render(); void ensureLoaded().catch(() => {}); }
    return { mount, sync, ensureLoaded, capture };
  }
  return { create };
});
