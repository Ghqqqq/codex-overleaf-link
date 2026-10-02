(function initRunPresence(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafModuleRegistry.define('RunPresence', [], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function runPresenceFactory() {
  'use strict';

  // Presentation-only run header: the animated brand mark, the live label and
  // the settled summary. It never reads or writes run records.
  const VERBS = {
    en: ['Vibe writing', 'Typesetting', 'Kerning', 'Footnoting', 'Citing sources', 'Peer-reviewing',
      'Polishing prose', 'Balancing braces', 'Chasing references', 'Proofreading', 'Untangling macros',
      'Hunting overfull hboxes'],
    zh: ['推敲中', '斟酌措辞', '排版中', '查文献', '对齐公式', '润色中', '翻稿纸', '补脚注', '配平括号',
      '追引用', '校对中', '抓 overfull hbox']
  };
  const TIPS = {
    en: ['Type @ to add a file as context, e.g. @sections/intro.tex.',
      'Ask for an edit, not a rewrite: “tighten §2, keep every citation”.',
      'Compile errors can go straight back to Codex from the log.',
      '\\label everything. Cross-references are cheaper than prose.',
      'Reviewer 2 is not here. Yet.',
      'Overfull \\hbox? Ask Codex to rephrase the line, not shrink the font.'],
    zh: ['输入 @ 把文件加入上下文，比如 @sections/intro.tex。',
      '让它“改”而不是“重写”：“精简 §2，保留所有引用”。',
      '编译报错可以直接从日志发回给 Codex。',
      '多打 \\label。交叉引用比文字描述省事。',
      'Reviewer 2 还没来，趁现在。',
      'Overfull \\hbox？让 Codex 改写这一行，而不是缩字号。']
  };
  // The header word changes rarely: at 1, 3, 7 and 15 minutes, so even a long run shows only a few words.
  const WORD_AT_MS = [0, 60000, 180000, 420000, 900000];
  const LONG_RUN_MS = 120000;
  // Layers (inlined in panel.css) are pixel-exact slices of assets/icons/codex-overleaf-icon.png;
  // the origins (percent of the square crop) are the leaf stem and cloud centre.
  const MARK_LAYERS = ['cloud', 'cursor', 'leaf'];
  const MARK_STYLE = '--mark-leaf-origin:70.6% 41.6%;--mark-cloud-origin:44.3% 55%';
  const ICONS = {
    alert: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5v4 M8 11h.01"/>',
    check: '<path d="m3.5 8 3 3 6-6"/>',
    file: '<path d="M9 2H4v12h8V5L9 2Z M9 2v4h3 M6 9h4 M6 11h3"/>',
    refresh: '<path d="M4.2 5.3A5 5 0 1 1 3.6 10"/><path d="M4.2 2.2v3.1H1.1"/>'
  };

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function icon(name, className = 'codex-glyph') {
    return '<svg class="' + className + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + (ICONS[name] || ICONS.check) + '</svg>';
  }

  function qed(className = '') {
    return '<span class="run-qed' + (className ? ' ' + className : '') + '" aria-hidden="true">'
      + '<svg viewBox="0 0 11 11" focusable="false"><rect x="1" y="1" width="9" height="9" rx=".6"/></svg></span>';
  }

  function pickDifferent(list, previous, random) {
    if (list.length < 2) return list[0] || '';
    const index = Math.min(list.length - 1, Math.floor(random() * list.length));
    // Step past a repeat instead of re-rolling, so a fixed random source can never spin.
    return list[index] === previous ? list[(index + 1) % list.length] : list[index];
  }

  // Tool rows win over playful verbs; the label names the real action.
  function activityVerb(item, tx) {
    const meta = item?.meta || {};
    if (item?.kind === 'explore') {
      return ({ read: tx('Reading', '读取'), search: tx('Searching', '搜索'), list: tx('Listing', '查看') })[meta.action]
        || tx('Exploring', '查阅');
    }
    if (item?.kind === 'edit') {
      return ({ add: tx('Creating', '新建'), delete: tx('Deleting', '删除'), move: tx('Moving', '移动') })[item.file?.operation]
        || tx('Editing', '修改');
    }
    return ({ command: tx('Running', '执行'), compile: tx('Compiling', '编译'), sync: tx('Syncing to Overleaf', '同步到 Overleaf'),
      tool: tx('Using', '调用'), agent: tx('Delegating', '委派子代理'), plan: tx('Planning', '规划') })[item?.kind]
      || tx('Working', '处理中');
  }

  // Header-only command label: drop the shell wrapper and the leading `cd …&&`, keep the first command.
  function commandSummary(command) {
    let text = String(command || '').trim().replace(/^(?:\/usr)?\/bin\/(?:ba|z)?sh\s+-l?c\s+/, '');
    if (/^(["']).*\1$/s.test(text)) text = text.slice(1, -1);
    text = text.replace(/^cd\s+.*?&&\s*/, '').split(/\s*(?:&&|\|\||[|;])\s*/)[0].replace(/\s+/g, ' ').trim();
    return text.length > 48 ? text.slice(0, 47) + '…' : text;
  }

  // Settled header: ∎ (end of proof) followed by what the run actually did.
  function settledHtml(facts = {}, tx, formatElapsed) {
    const hasElapsed = Number.isFinite(facts.elapsedMs);
    const elapsed = hasElapsed ? '<span>' + escapeHtml(formatElapsed(facts.elapsedMs)) + '</span>' : '';
    const sep = '<span class="run-summary-sep">·</span>';
    if (facts.kind === 'stopped') {
      return qed('is-open' + (facts.animate ? ' is-settling' : '')) + '<span class="run-summary-stopped">\\end{draft}</span>'
        + (hasElapsed ? sep + '<span>' + escapeHtml(tx('stopped at ', '停在 ') + formatElapsed(facts.elapsedMs)) + '</span>' : '');
    }
    const parts = elapsed ? [elapsed] : [];
    if (facts.files > 0) {
      const files = tx(facts.files + (facts.files === 1 ? ' file' : ' files'), facts.files + ' 个文件');
      // A clipped history only proves the files it recorded.
      parts.push('<span>' + escapeHtml(facts.filesClipped ? tx(files + ' recorded', '已记录 ' + files) : files) + '</span>');
      if (facts.added || facts.removed) {
        parts.push('<span><span class="run-summary-add">+' + Number(facts.added || 0) + '</span> <span class="run-summary-del">−'
          + Number(facts.removed || 0) + '</span></span>');
      }
    } else if (facts.steps > 0) {
      parts.push('<span>' + escapeHtml(tx(facts.steps + ' steps', facts.steps + ' 步')) + '</span>');
    }
    if (facts.compiled) parts.push('<span>' + escapeHtml(tx('compiled', '已编译')) + '</span>');
    if (facts.firstCompile) {
      parts.push('<span class="run-summary-qed">' + escapeHtml(tx('Q.E.D. — first clean compile', 'Q.E.D. · 首次编译通过')) + '</span>');
    }
    const mark = qed(facts.animate ? 'is-settling' + (facts.firstCompile ? ' is-first' : '') : '');
    return '<span class="codex-sr-only">' + escapeHtml(tx('Done', '已完成')) + '</span>' + mark + parts.join(sep);
  }

  function create(deps = {}) {
    const tx = deps.tx || ((en) => en);
    const locale = () => (deps.getLocale?.() === 'zh' ? 'zh' : 'en');
    const formatElapsed = deps.formatElapsed || (ms => Math.round(ms / 1000) + 's');
    const now = deps.now || Date.now;
    const random = deps.random || Math.random;
    const storage = deps.storage === undefined ? safeStorage() : deps.storage;
    // Wrapped, never stored bare: browser timers throw "Illegal invocation" when called as methods of another object.
    const timers = { later: (fn, ms) => (deps.setTimeout || globalThis.setTimeout)(fn, ms) };
    const doc = () => deps.document || globalThis.document;
    const live = new WeakMap();
    const longRunsShown = new Set();
    let tipIndex = Math.floor(random() * TIPS.en.length);

    function safeStorage() {
      try { return globalThis.localStorage || null; } catch { return null; }
    }
    function once(key) {
      try {
        if (!storage || storage.getItem(key)) return false;
        storage.setItem(key, '1');
        return true;
      } catch { return false; }
    }
    function isLateNight() {
      const hour = new Date(now()).getHours();
      return hour >= 23 || hour < 5;
    }
    function lateNightEgg() {
      if (!isLateNight()) return '';
      // One "night" runs until 05:00, so a 01:00 run belongs to the previous date.
      const night = new Date(now() - 5 * 3600000).toDateString();
      return once('codex-overleaf:egg:late-night:' + night) ? tx('Burning the midnight oil', '挑灯夜战') : '';
    }

    function markHtml(className = '') {
      return '<span class="run-mark' + (className ? ' ' + className : '') + '" aria-hidden="true" style="' + MARK_STYLE + '">'
        + MARK_LAYERS.map(layer => '<span class="run-mark-' + layer + '"></span>').join('') + '</span>';
    }

    function stop(el) {
      live.delete(el);
    }

    function swapLabel(state, html, egg = false) {
      const box = state.label;
      const next = doc().createElement('span');
      next.className = 'is-in';
      next.innerHTML = '<span class="run-shimmer' + (egg ? ' is-egg' : '') + '">' + html + '…</span>';
      // Drop anything still fading out, so a slow timer can never leave the label blank.
      for (const stale of [...(box.children || [])]) if (stale.className === 'is-out') stale.remove();
      const old = box.lastElementChild;
      box.append(next);
      if (old) {
        old.className = 'is-out';
        timers.later(() => old.remove(), 280);
      }
    }

    function nextIdle(state) {
      const egg = state.eggs.shift();
      if (egg) { swapLabel(state, escapeHtml(egg), true); return; }
      state.verb = pickDifferent(VERBS[locale()], state.verb, random);
      swapLabel(state, escapeHtml(state.verb));
    }

    function wordSlot(elapsedMs) {
      let slot = 0;
      for (let index = 0; index < WORD_AT_MS.length; index += 1) if (elapsedMs >= WORD_AT_MS[index]) slot = index;
      return slot;
    }

    function ensureRunning(el, runId) {
      let state = live.get(el);
      if (state && state.runId === runId) return state;
      stop(el);
      el.dataset.presence = 'running';
      el.innerHTML = markHtml() + '<span class="codex-sr-only">' + escapeHtml(tx('Running', '运行中')) + '</span>'
        + '<span class="run-presence-label"></span><span class="run-presence-timer"></span>';
      state = { runId, key: '', verb: '', slot: -1, elapsedMs: 0, eggs: [], label: el.querySelector('.run-presence-label'),
        timer: el.querySelector('.run-presence-timer') };
      const late = lateNightEgg();
      if (late) state.eggs.push(late);
      live.set(el, state);
      return state;
    }

    // label: { kind: 'stage', text } | { kind: 'idle' }. Tool steps live in the round list, not the header.
    function paintRunning(el, { runId = '', label = { kind: 'idle' }, elapsedMs } = {}) {
      if (!el) return;
      const state = ensureRunning(el, runId);
      state.idle = label.kind !== 'stage';
      if (elapsedMs !== undefined) tick(el, elapsedMs);
      if (!state.idle) {
        const key = 's:' + label.text;
        if (key !== state.key) { state.key = key; swapLabel(state, escapeHtml(label.text)); }
        return;
      }
      refreshWord(state);
    }

    function refreshWord(state) {
      const slot = wordSlot(state.elapsedMs);
      if (state.key === 'idle' && slot === state.slot) return;
      state.key = 'idle';
      state.slot = slot;
      nextIdle(state);
    }

    function tick(el, elapsedMs) {
      const state = live.get(el);
      if (!state) return;
      const value = formatElapsed(elapsedMs);
      if (state.timer.textContent !== value) state.timer.textContent = value;
      state.elapsedMs = elapsedMs;
      if (elapsedMs > LONG_RUN_MS && state.runId && !longRunsShown.has(state.runId)) {
        longRunsShown.add(state.runId);
        state.eggs.push(tx('This is a long proof', '这是个长证明'));
      }
      if (state.idle) refreshWord(state);
    }

    // facts: { kind: 'done' | 'stopped' | 'failed' | 'plain', text, elapsedMs, files, added, removed,
    //          steps, compiled, projectId, animate }
    function paintSettled(el, facts = {}) {
      if (!el) return;
      stop(el);
      const firstCompile = facts.kind === 'done' && facts.animate && facts.compiled && facts.projectId
        ? once('codex-overleaf:egg:first-compile:' + facts.projectId) : false;
      const stamp = JSON.stringify({ ...facts, animate: false });
      if (el.dataset.presenceStamp === stamp && !facts.animate) return;
      el.dataset.presenceStamp = stamp;
      el.dataset.presence = facts.kind || 'plain';
      if (facts.kind === 'done' || facts.kind === 'stopped') {
        el.innerHTML = settledHtml({ ...facts, firstCompile }, tx, formatElapsed);
      } else if (facts.kind === 'failed') {
        el.innerHTML = icon('alert') + '<span>' + escapeHtml(facts.text) + '</span>';
      } else {
        el.textContent = facts.text || '';
      }
    }

    function emptyTitle() {
      return isLateNight() ? tx("Still up? Let's finish this section.", '还没睡？把这一节写完吧。')
        : tx('What are we writing today?', '今天写点什么？');
    }

    // Decorates the existing empty-state element with the mark, project chip and a tip.
    function decorateEmpty(empty, { projectName = '' } = {}) {
      const mark = doc().createElement('div');
      mark.className = 'run-empty-mark';
      mark.innerHTML = markHtml('is-large');
      empty.prepend(mark);
      const title = empty.querySelector('.empty-runs-title');
      if (title) title.textContent = emptyTitle();
      if (projectName) {
        const chip = doc().createElement('span');
        chip.className = 'run-empty-project';
        chip.innerHTML = icon('file') + '<span></span>';
        chip.lastElementChild.textContent = projectName;
        title?.after(chip);
      }
      const tip = doc().createElement('div');
      tip.className = 'run-empty-tip';
      tip.innerHTML = '<span class="run-empty-pilcrow" aria-hidden="true">¶</span><span class="run-empty-tip-text"></span>'
        + '<button type="button" class="run-empty-tip-next">' + icon('refresh') + '</button>';
      const next = tip.querySelector('button');
      next.title = tx('Next tip', '换一条');
      next.setAttribute('aria-label', next.title);
      const show = () => {
        const old = tip.querySelector('.run-empty-tip-text');
        const fresh = old.cloneNode(false);
        fresh.textContent = TIPS[locale()][tipIndex % TIPS.en.length];
        old.replaceWith(fresh);
      };
      next.addEventListener('click', () => { tipIndex += 1; show(); });
      show();
      empty.append(tip);
      return empty;
    }

    return { markHtml, paintRunning, tick, paintSettled, decorateEmpty, stop };
  }

  return { create, VERBS, TIPS, activityVerb, commandSummary, settledHtml, icon };
});
