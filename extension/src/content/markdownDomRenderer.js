(function initCodexOverleafMarkdownDomRenderer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CodexOverleafMarkdownDomRenderer = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function markdownDomRendererFactory() {
  'use strict';

  const DEFAULT_LIMITS = Object.freeze({
    maxChars: 1_000_000,
    maxTokens: 25_000,
    maxNesting: 32
  });
  const BLOCK_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td'
  ]);
  const INLINE_TAGS = new Map([
    ['em_open', 'em'],
    ['strong_open', 'strong'],
    ['s_open', 's']
  ]);
  const probedFontDocuments = new WeakSet();
  let cachedMarkdownIt = null;
  let cachedMathText = null;
  let cachedMaxNesting = null;
  let cachedParser = null;

  function renderMarkdown(target, value, options = {}) {
    if (!target || typeof target.replaceChildren !== 'function') {
      throw rendererError('markdown_target_invalid', 'Markdown target is unavailable.');
    }
    const document = options.document || target.ownerDocument;
    if (!document || typeof document.createDocumentFragment !== 'function') {
      throw rendererError('markdown_document_invalid', 'Markdown document is unavailable.');
    }
    const source = stripEmptyHtmlComments(String(value || ''));
    const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    if (source.length > limits.maxChars) {
      throw rendererError('markdown_source_too_large', `Markdown source exceeds ${limits.maxChars} UTF-16 code units.`);
    }

    const parser = options.parser || getParser({
      markdownIt: options.markdownIt,
      mathText: options.mathText,
      maxNesting: limits.maxNesting
    });
    const tokens = parser.parse(source, {});
    const tokenCount = countTokens(tokens);
    if (tokenCount > limits.maxTokens) {
      throw rendererError('markdown_token_limit', `Markdown token count exceeds ${limits.maxTokens}.`);
    }

    const fragment = document.createDocumentFragment();
    const context = {
      document,
      renderTextNodes: options.renderTextNodes || (text => [document.createTextNode(text)]),
      renderLinkNodes: options.renderLinkNodes || (label => [document.createTextNode(label)]),
      renderCodeNodes: options.renderCodeNodes,
      sanitizeText: options.sanitizeText || (text => String(text || '')),
      createMathNode: options.createMathNode,
      recordDiagnostic: options.recordDiagnostic,
      mathRendered: false
    };
    renderBlockTokens(tokens, fragment, context);
    target.replaceChildren(fragment);
    if (context.mathRendered) {
      probeMathFonts(document, context.recordDiagnostic);
    }
    return { tokenCount };
  }

  function getParser({ markdownIt, mathText, maxNesting }) {
    if (typeof markdownIt !== 'function') {
      throw rendererError('markdown_parser_missing', 'The vendored Markdown parser is unavailable.');
    }
    if (!mathText || typeof mathText.matchMathAt !== 'function') {
      throw rendererError('markdown_math_rule_missing', 'The shared math delimiter matcher is unavailable.');
    }
    if (
      cachedParser &&
      cachedMarkdownIt === markdownIt &&
      cachedMathText === mathText &&
      cachedMaxNesting === maxNesting
    ) {
      return cachedParser;
    }
    const parser = markdownIt({
      html: false,
      linkify: false,
      typographer: false,
      breaks: false,
      maxNesting
    });
    installMathRules(parser, mathText);
    cachedMarkdownIt = markdownIt;
    cachedMathText = mathText;
    cachedMaxNesting = maxNesting;
    cachedParser = parser;
    return parser;
  }

  function installMathRules(parser, mathText) {
    parser.inline.ruler.before('escape', 'codex_math_inline', (state, silent) => {
      const match = mathText.matchMathAt(state.src, state.pos);
      if (!match) {
        return false;
      }
      if (!silent) {
        const token = state.push('math_inline', 'span', 0);
        token.content = match.value;
        token.markup = match.raw.slice(0, 2);
        token.meta = { display: match.display, raw: match.raw };
      }
      state.pos = match.end;
      return true;
    });

    parser.block.ruler.before('lheading', 'codex_math_block', (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const match = mathText.matchMathAt(state.src, start);
      if (!match || !match.display) {
        return false;
      }
      let lastLine = startLine;
      while (lastLine < endLine && state.eMarks[lastLine] < match.end) {
        lastLine += 1;
      }
      if (lastLine >= endLine || state.src.slice(match.end, state.eMarks[lastLine]).trim()) {
        return false;
      }
      if (silent) {
        return true;
      }
      const token = state.push('math_block', 'div', 0);
      token.block = true;
      token.content = match.value;
      token.map = [startLine, lastLine + 1];
      token.markup = match.raw.slice(0, 2);
      token.meta = { display: true, raw: match.raw };
      state.line = lastLine + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  }

  function renderBlockTokens(tokens, rootNode, context) {
    const stack = [{ node: rootNode, closeType: '' }];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const parent = stack[stack.length - 1].node;

      if (
        token.type === 'paragraph_open' &&
        tokens[index + 1]?.type === 'inline' &&
        tokens[index + 2]?.type === 'paragraph_close'
      ) {
        const children = tokens[index + 1].children || [];
        if (token.hidden) {
          renderInlineTokens(children, parent, context);
        } else {
          renderParagraphFlow(children, parent, context);
        }
        index += 2;
        continue;
      }

      if (token.type === 'inline') {
        renderInlineTokens(token.children || [], parent, context);
        continue;
      }
      if (token.type === 'fence' || token.type === 'code_block') {
        appendCodeBlock(parent, token, context);
        continue;
      }
      if (token.type === 'math_block') {
        parent.append(createMathNode(token, context, true));
        continue;
      }
      if (token.type === 'hr') {
        parent.append(context.document.createElement('hr'));
        continue;
      }
      if (token.nesting === 1) {
        const node = createBlockContainer(token, context);
        parent.append(node);
        stack.push({
          node,
          closeType: token.type.replace(/_open$/, '_close')
        });
        continue;
      }
      if (token.nesting === -1) {
        const frame = stack.pop();
        if (!frame || frame.closeType !== token.type || stack.length === 0) {
          throw rendererError('markdown_structure_invalid', `Unexpected closing token: ${token.type}.`);
        }
        continue;
      }
      throw rendererError('markdown_token_unsupported', `Unsupported Markdown token: ${token.type}.`);
    }
    if (stack.length !== 1) {
      throw rendererError('markdown_structure_invalid', 'Markdown token nesting did not close cleanly.');
    }
  }

  function createBlockContainer(token, context) {
    const tag = String(token.tag || '').toLowerCase();
    if (!BLOCK_TAGS.has(tag)) {
      throw rendererError('markdown_block_unsupported', `Unsupported Markdown container: ${tag || token.type}.`);
    }
    const node = context.document.createElement(tag);
    if (tag === 'table') {
      node.className = 'run-markdown-table';
    }
    if (tag === 'blockquote') {
      node.className = 'run-markdown-quote';
    }
    if (tag === 'ol') {
      const start = Number(token.attrGet?.('start'));
      if (Number.isSafeInteger(start) && start > 1) {
        node.setAttribute('start', String(start));
      }
    }
    if (tag === 'th' || tag === 'td') {
      const alignment = String(token.attrGet?.('style') || '').match(/text-align:\s*(left|center|right)/i)?.[1];
      if (alignment) {
        node.classList.add(`is-align-${alignment.toLowerCase()}`);
      }
    }
    return node;
  }

  function appendCodeBlock(parent, token, context) {
    const pre = context.document.createElement('pre');
    pre.className = 'run-code-block';
    const code = context.document.createElement('code');
    code.textContent = context.sanitizeText(token.content || '');
    const language = String(token.info || '').trim().split(/\s+/)[0].replace(/[^a-z0-9_-]/gi, '');
    if (language) {
      code.className = `language-${language}`;
    }
    pre.append(code);
    parent.append(pre);
  }

  function renderParagraphFlow(tokens, parent, context) {
    let segment = [];
    const flush = () => {
      if (!segment.length) {
        return;
      }
      const paragraph = context.document.createElement('p');
      const meaningful = segment.filter(token => token.type !== 'softbreak' && (
        token.type !== 'text' || String(token.content || '').trim()
      ));
      renderInlineTokens(segment, paragraph, context, {
        standaloneCode: meaningful.length === 1 && meaningful[0].type === 'code_inline'
      });
      if (paragraphHasContent(paragraph)) {
        parent.append(paragraph);
      }
      segment = [];
    };
    let nesting = 0;
    for (const token of tokens) {
      if (token.nesting === 1) nesting += 1;
      if (token.type === 'math_inline' && token.meta?.display && nesting === 0) {
        flush();
        parent.append(createMathNode(token, context, true));
        continue;
      }
      segment.push(token);
      if (token.nesting === -1) nesting = Math.max(0, nesting - 1);
    }
    flush();
  }

  function paragraphHasContent(node) {
    return Boolean(node.childNodes?.length || String(node.textContent || '').trim());
  }

  function renderInlineTokens(tokens, rootNode, context, renderOptions = {}) {
    const stack = [{ node: rootNode, closeType: '' }];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const parent = stack[stack.length - 1].node;
      if (token.type === 'text' || token.type === 'html_inline') {
        appendNodes(parent, context.renderTextNodes(context.sanitizeText(token.content || '')));
        continue;
      }
      if (token.type === 'softbreak') {
        parent.append(context.document.createTextNode(' '));
        continue;
      }
      if (token.type === 'hardbreak') {
        parent.append(context.document.createElement('br'));
        continue;
      }
      if (token.type === 'code_inline') {
        if (renderOptions.standaloneCode && typeof context.renderCodeNodes === 'function') {
          appendNodes(parent, context.renderCodeNodes(context.sanitizeText(token.content || '')));
          continue;
        }
        const code = context.document.createElement('code');
        code.className = 'run-inline-code';
        code.textContent = context.sanitizeText(token.content || '');
        parent.append(code);
        continue;
      }
      if (token.type === 'math_inline') {
        parent.append(createMathNode(token, context, Boolean(token.meta?.display)));
        continue;
      }
      if (token.type === 'image') {
        appendNodes(parent, context.renderTextNodes(context.sanitizeText(token.content || token.attrGet?.('alt') || '')));
        continue;
      }
      if (token.type === 'link_open') {
        const closeIndex = findMatchingInlineClose(tokens, index, 'link_open', 'link_close');
        const label = extractInlineText(tokens.slice(index + 1, closeIndex));
        const href = String(token.attrGet?.('href') || '');
        appendNodes(parent, context.renderLinkNodes(context.sanitizeText(label), href));
        index = closeIndex;
        continue;
      }
      if (INLINE_TAGS.has(token.type)) {
        const node = context.document.createElement(INLINE_TAGS.get(token.type));
        parent.append(node);
        stack.push({ node, closeType: token.type.replace(/_open$/, '_close') });
        continue;
      }
      if (token.nesting === -1) {
        const frame = stack.pop();
        if (!frame || frame.closeType !== token.type || stack.length === 0) {
          throw rendererError('markdown_inline_structure_invalid', `Unexpected inline closing token: ${token.type}.`);
        }
        continue;
      }
      throw rendererError('markdown_inline_unsupported', `Unsupported inline Markdown token: ${token.type}.`);
    }
    if (stack.length !== 1) {
      throw rendererError('markdown_inline_structure_invalid', 'Inline Markdown token nesting did not close cleanly.');
    }
  }

  function findMatchingInlineClose(tokens, start, openType, closeType) {
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1) {
      if (tokens[index].type === openType) depth += 1;
      if (tokens[index].type === closeType) depth -= 1;
      if (depth === 0) return index;
    }
    throw rendererError('markdown_link_unclosed', 'Markdown link did not close cleanly.');
  }

  function extractInlineText(tokens) {
    return tokens.map(token => {
      if (token.type === 'image') return token.content || token.attrGet?.('alt') || '';
      if (token.children) return extractInlineText(token.children);
      return token.content || '';
    }).join('');
  }

  function createMathNode(token, context, forceDisplay) {
    if (typeof context.createMathNode !== 'function') {
      throw rendererError('markdown_math_renderer_missing', 'The KaTeX node renderer is unavailable.');
    }
    const display = Boolean(forceDisplay || token.meta?.display);
    const raw = token.meta?.raw || (display ? `$$${token.content}$$` : `$${token.content}$`);
    const node = context.createMathNode({
      type: 'math',
      raw,
      value: token.content,
      display
    });
    if (!node) {
      throw rendererError('markdown_math_node_invalid', 'The KaTeX node renderer returned no node.');
    }
    context.mathRendered = true;
    return node;
  }

  function appendNodes(parent, value) {
    const nodes = Array.isArray(value) ? value : (value ? [value] : []);
    for (const node of nodes) {
      if (node) parent.append(node);
    }
  }

  function countTokens(tokens) {
    let total = 0;
    const visit = list => {
      for (const token of list || []) {
        total += 1;
        if (token.children?.length) visit(token.children);
      }
    };
    visit(tokens);
    return total;
  }

  function stripEmptyHtmlComments(value) {
    return String(value || '').replace(/<!--\s*-->/g, '');
  }

  function probeMathFonts(document, recordDiagnostic) {
    const fonts = document.fonts;
    if (!fonts || typeof fonts.load !== 'function' || probedFontDocuments.has(document)) {
      return;
    }
    probedFontDocuments.add(document);
    const families = ['KaTeX_Main', 'KaTeX_Math', 'KaTeX_AMS', 'KaTeX_Size1'];
    Promise.allSettled(families.map(family => fonts.load(`16px "${family}"`)))
      .then(async results => {
        await Promise.resolve(fonts.ready);
        const missing = results.flatMap((result, index) => (
          result.status === 'rejected' || !result.value?.length ? [families[index]] : []
        ));
        if (missing.length && typeof recordDiagnostic === 'function') {
          recordDiagnostic({
            code: 'katex_font_load_incomplete',
            detail: `KaTeX font families did not load: ${missing.join(', ')}`
          });
        }
      })
      .catch(() => {
        if (typeof recordDiagnostic === 'function') {
          recordDiagnostic({
            code: 'katex_font_probe_failed',
            detail: 'KaTeX font readiness could not be verified.'
          });
        }
      });
  }

  function rendererError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  return {
    DEFAULT_LIMITS,
    countTokens,
    renderMarkdown,
    stripEmptyHtmlComments
  };
});
