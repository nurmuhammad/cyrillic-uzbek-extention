// Саҳифадан асосий ўқиладиган матнни ажратиб олиш.
// Readability'нинг соддалаштирилган варианти: номзод блокларни матн зичлиги
// бўйича баҳолаб, навигация/футер/реклама кабиларни жазолаймиз.

(() => {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP',
    'VAR', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS',
    'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO',
  ]);

  const NOISE_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM']);

  const NOISE_RE = /(^|[-_\s])(nav|menu|sidebar|side-bar|footer|header|breadcrumb|comment|promo|banner|advert|\bads?\b|share|social|related|recommend|subscribe|newsletter|cookie|popup|modal|paywall|toolbar|pagination|widget)([-_\s]|$)/i;

  const EXPLICIT_SELECTORS = [
    'article',
    'main',
    '[role="main"]',
    '[itemprop="articleBody"]',
    '.post-content',
    '.entry-content',
    '.article-body',
    '.article__body',
    '#content',
  ];

  function isNoisy(el) {
    if (NOISE_TAGS.has(el.tagName)) return true;
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    return NOISE_RE.test(`${id} ${cls}`);
  }

  function visibleTextLength(el) {
    // innerText саҳифада кўринмайдиган матнни ҳисобга олмайди - бизга шу керак
    const text = el.innerText || '';
    return text.replace(/\s+/g, ' ').trim().length;
  }

  function scoreCandidate(el) {
    const length = visibleTextLength(el);
    if (length < 140) return 0;

    const paragraphs = el.querySelectorAll('p, li, h1, h2, h3, blockquote').length;
    const links = el.querySelectorAll('a').length;
    const linkText = Array.from(el.querySelectorAll('a'))
      .reduce((sum, a) => sum + (a.textContent || '').length, 0);
    const linkDensity = linkText / Math.max(1, length);

    let score = length * (1 + Math.min(paragraphs, 40) * 0.05);
    if (linkDensity > 0.5) score *= 0.2;      // навигацияга ўхшайди
    if (isNoisy(el)) score *= 0.15;
    if (links > paragraphs * 4) score *= 0.5;

    return score;
  }

  /** Асосий матн жойлашган элементни танлайди. */
  function pickRoot() {
    for (const selector of EXPLICIT_SELECTORS) {
      const el = document.querySelector(selector);
      if (el && visibleTextLength(el) > 400 && !isNoisy(el)) return el;
    }

    const candidates = document.querySelectorAll('article, main, section, div');
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const score = scoreCandidate(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best && bestScore > 0 ? best : document.body;
  }

  function hasLetters(text) {
    return /\p{L}/u.test(text);
  }

  function isSkippable(el, visibilityCache) {
    if (!el) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.closest('[data-uz-overlay]')) return true;

    if (visibilityCache.has(el)) return visibilityCache.get(el);
    const style = getComputedStyle(el);
    const hidden = style.display === 'none'
      || style.visibility === 'hidden'
      || Number(style.opacity) === 0;
    visibilityCache.set(el, hidden);
    return hidden;
  }

  /**
   * Фойдаланувчи белгилаган матн бўлса - унинг Range'ини қайтаради.
   * Бўш ёки жуда қисқа белгилаш эътиборга олинмайди (тасодифий клик).
   */
  function getSelectionRange(minChars = 3) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (text.length < minChars || !hasLetters(text)) return null;
    return selection.getRangeAt(0);
  }

  /** Range жойлашган элемент - TreeWalker учун илдиз. */
  function rangeRoot(range) {
    const node = range.commonAncestorContainer;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  /**
   * Танланган илдиз ичидаги таржима қилинадиган матн тугунларини йиғади.
   * @param {Element} root
   * @param {Range|null} range - берилса, фақат унга тегадиган тугунлар олинади
   * @returns {{node: Text, raw: string, lead: string, core: string, trail: string}[]}
   */
  function collectNodes(root, range = null) {
    const visibilityCache = new WeakMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const raw = node.nodeValue;
        if (!raw || !raw.trim() || !hasLetters(raw)) return NodeFilter.FILTER_REJECT;

        // Қисман тегиб турган тугун ҳам тўлиқ олинади: матн тугунини
        // ярмидан кесиб таржима қилиш грамматикани бузади.
        if (range && !range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;

        let el = node.parentElement;
        // Юқорига қараб текширамиз: яқин 5 та ота-элементнинг бирортаси
        // яширин/тегилмайдиган бўлса - ўтказиб юборамиз
        let depth = 0;
        while (el && depth < 5) {
          if (isSkippable(el, visibilityCache)) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
          depth += 1;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const items = [];
    let node = walker.nextNode();
    while (node) {
      const raw = node.nodeValue;
      const match = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
      items.push({
        node,
        raw,
        lead: match[1],
        core: match[2],
        trail: match[3],
      });
      node = walker.nextNode();
    }
    return items;
  }

  // ── Блок бирлигида йиғиш ───────────────────────────────────────────────────
  //
  // Матн тугунини алоҳида таржима қилиш ҳаволали жумлаларни бузади: ўзбекча
  // феъл жумла охирига кетиши керак, лекин у бошқа тугунда турган бўлса
  // қимирлатиб бўлмайди. Шунинг учун бутун абзацни ичидаги ҳаволалари билан
  // бирга, тегларга ўраб юборамиз:
  //
  //   "разработчик <1>объявил</1> о выходе <2>4MLinux 52.0</2>"
  //
  // Модель бутун жумлани кўради, ўзбекча тартибда қайта қуради ва тегларни ўз
  // жойига қўяди. Кейин биз тегларга қараб DOM'ни қайта тизамиз.

  const BLOCK_SELECTOR = [
    'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'dd', 'dt', 'figcaption', 'td', 'th', 'caption', 'summary',
  ].join(',');

  // Ичи кўчирилиши мумкин бўлган inline элементлар. Рўйхатда йўқ элемент
  // учраса, блок эски усулда (тугун-тугун) таржима қилинади.
  const INLINE_OK = new Set([
    'A', 'B', 'STRONG', 'EM', 'I', 'U', 'SPAN', 'MARK', 'SMALL', 'ABBR',
    'CITE', 'Q', 'TIME', 'INS', 'DEL', 'SUP', 'SUB', 'BDI', 'FONT',
  ]);

  const MAX_INLINE = 12;

  /**
   * Битта блокни таржима бирлигига айлантиради.
   * @returns {null|{block, texts, elements, template, children}}
   */
  function buildBlockUnit(block, visibilityCache, range) {
    if (range && !range.intersectsNode(block)) return null;
    if (isSkippable(block, visibilityCache)) return null;
    if (block.querySelector(BLOCK_SELECTOR)) return null;   // ичма-ич блок

    const texts = [];       // блокнинг ўз матн тугунлари
    const elements = [];    // теглар остидаги inline элементлар
    let template = '';

    for (const child of block.childNodes) {
      if (child.nodeType === Node.COMMENT_NODE) continue;

      if (child.nodeType === Node.TEXT_NODE) {
        template += child.nodeValue;
        texts.push(child);
        continue;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) return null;
      if (!INLINE_OK.has(child.tagName)) return null;
      if (child.children.length) return null;               // ичма-ич разметка
      if (isSkippable(child, visibilityCache)) return null;

      const inner = child.textContent;
      if (!inner || !inner.trim()) return null;

      elements.push(child);
      template += `<${elements.length}>${inner}</${elements.length}>`;
    }

    // Inline элемент бўлмаса, оддий йўл кифоя
    if (!elements.length || elements.length > MAX_INLINE) return null;
    if (!hasLetters(template) || !template.trim()) return null;

    return {
      block,
      texts,
      elements,
      template,
      children: Array.from(block.childNodes),
    };
  }

  /**
   * Илдиз ичидаги блок бирликларини йиғади ва улар «еб қўйган» матн
   * тугунларини WeakSet орқали қайтаради - қолгани эски йўлдан ўтади.
   */
  function collectBlocks(root, range = null) {
    const visibilityCache = new WeakMap();
    const units = [];
    const consumed = new WeakSet();

    const blocks = root.matches && root.matches(BLOCK_SELECTOR)
      ? [root, ...root.querySelectorAll(BLOCK_SELECTOR)]
      : Array.from(root.querySelectorAll(BLOCK_SELECTOR));

    for (const block of blocks) {
      const unit = buildBlockUnit(block, visibilityCache, range);
      if (!unit) continue;

      units.push(unit);
      for (const node of unit.texts) consumed.add(node);
      for (const el of unit.elements) {
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) consumed.add(node);
        }
      }
    }

    return { units, consumed };
  }

  /** Хулоса учун ўқиладиган матнни бир бутун сатр қилиб беради. */
  function readableText(root) {
    const text = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }

  self.UZ_EXTRACT = {
    pickRoot,
    collectNodes,
    collectBlocks,
    readableText,
    getSelectionRange,
    rangeRoot,
  };
})();
