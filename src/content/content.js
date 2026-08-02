// Асосий content script. Саҳифадаги матнни ўрнида алмаштиради, аслини
// хотирада сақлаб қолади ва хулоса панелини кўрсатади.
//
// Диққат: бу ерда API-калит умуман ишлатилмайди. Барча тармоқ сўровлари
// background service worker орқали кетади.

(() => {
  if (self.__UZ_TR_READY) return;
  self.__UZ_TR_READY = true;

  const CONTENT_DEFAULTS = {
    scope: 'main',
    batchChars: 1500,
    concurrency: 4,
    showBadge: true,
  };

  const state = {
    status: 'idle', // idle | running | done | error | cancelled
    mode: null,     // llm | translit | summary
    done: 0,
    total: 0,
    error: null,
    translated: false,
    summary: null,
    fromCache: 0,   // кэшдан олинган бўлаклар сони
    fresh: 0,       // моделдан янги сўралган бўлаклар сони
  };

  /** Аслига қайтариш учун: {node, raw} рўйхати. */
  let originals = [];

  // Жорий сеанс. Бекор қилиш шу контекст орқали ишлайди: `cancelled` байроғи
  // янги пакетлар юборилишини тўхтатади, `id` эса background'даги учиб турган
  // fetch'ларни узиш учун керак.
  let runCounter = 0;
  let activeRun = null;

  // ── Оверлей (badge + хулоса панели) ────────────────────────────────────────

  let overlay = null;

  function ensureOverlay() {
    if (overlay && document.documentElement.contains(overlay.host)) return overlay;

    const host = document.createElement('div');
    host.setAttribute('data-uz-overlay', '');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, "Segoe UI", Arial, sans-serif; }
        .badge {
          position: fixed; right: 16px; bottom: 16px;
          background: #10233d; color: #eaf1fb;
          padding: 10px 14px; border-radius: 10px;
          font-size: 13px; line-height: 1.35; max-width: 280px;
          box-shadow: 0 6px 24px rgba(0,0,0,.28);
          display: none;
        }
        .badge.show { display: block; }
        .badge.error { background: #4a1420; }
        .bar { height: 4px; background: #24406b; border-radius: 2px; margin-top: 8px; overflow: hidden; }
        .bar > i { display: block; height: 100%; background: #4d9bff; width: 0%; transition: width .2s; }

        .panel {
          position: fixed; right: 16px; top: 16px;
          width: 400px; max-width: calc(100vw - 32px);
          max-height: calc(100vh - 32px);
          background: #ffffff; color: #16202e;
          border: 1px solid #d6dee9; border-radius: 12px;
          box-shadow: 0 10px 40px rgba(0,0,0,.24);
          display: none; flex-direction: column; overflow: hidden;
        }
        .panel.show { display: flex; }
        .panel header {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 12px; background: #f2f5fa; border-bottom: 1px solid #e1e8f0;
          font-size: 13px; font-weight: 600;
        }
        .panel header .spacer { flex: 1; }
        .panel button {
          border: 1px solid #cfd8e4; background: #fff; color: #16202e;
          border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer;
        }
        .panel button:hover { background: #eef3fa; }
        .panel .body {
          padding: 12px 14px; overflow: auto; font-size: 14px; line-height: 1.6;
          white-space: pre-wrap; word-break: break-word;
        }
        @media (prefers-color-scheme: dark) {
          .panel { background: #131a24; color: #e6edf5; border-color: #2a3646; }
          .panel header { background: #1b2431; border-bottom-color: #2a3646; }
          .panel button { background: #1b2431; color: #e6edf5; border-color: #35435a; }
          .panel button:hover { background: #24304060; }
        }
      </style>
      <div class="badge"><span class="badge-text"></span><div class="bar"><i></i></div></div>
      <div class="panel">
        <header>
          <span>Саҳифа хулосаси</span>
          <span class="spacer"></span>
          <button class="copy">Нусха</button>
          <button class="close">Ёпиш</button>
        </header>
        <div class="body"></div>
      </div>
    `;
    document.documentElement.appendChild(host);

    const refs = {
      host,
      shadow,
      badge: shadow.querySelector('.badge'),
      badgeText: shadow.querySelector('.badge-text'),
      bar: shadow.querySelector('.bar > i'),
      panel: shadow.querySelector('.panel'),
      panelBody: shadow.querySelector('.body'),
    };

    shadow.querySelector('.close').addEventListener('click', () => {
      refs.panel.classList.remove('show');
    });
    shadow.querySelector('.copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(refs.panelBody.textContent || '');
      } catch { /* clipboard рухсати йўқ бўлиши мумкин */ }
    });

    overlay = refs;
    return overlay;
  }

  function showBadge(text, { progress = null, error = false, autoHideMs = 0 } = {}) {
    if (!settingsCache.showBadge) return;
    const ui = ensureOverlay();
    ui.badgeText.textContent = text;
    ui.badge.classList.toggle('error', error);
    ui.badge.classList.add('show');
    ui.bar.style.width = progress === null ? '0%' : `${Math.round(progress * 100)}%`;
    if (autoHideMs) {
      setTimeout(() => ui.badge.classList.remove('show'), autoHideMs);
    }
  }

  function hideBadge() {
    if (overlay) overlay.badge.classList.remove('show');
  }

  function showPanel(text) {
    const ui = ensureOverlay();
    ui.panelBody.textContent = text;
    ui.panel.classList.add('show');
  }

  // ── Созламалар ─────────────────────────────────────────────────────────────

  let settingsCache = { ...CONTENT_DEFAULTS };

  async function loadSettings() {
    settingsCache = await chrome.storage.local.get(CONTENT_DEFAULTS);
    return settingsCache;
  }

  // ── Ёрдамчилар ─────────────────────────────────────────────────────────────

  function publish() {
    // Popup ёпиқ бўлса тингловчи қолмайди - хатони ютиб юборамиз.
    // MV3 да callback'сиз sendMessage Promise қайтаради, шунинг учун
    // try/catch етарли эмас.
    try {
      const result = chrome.runtime.sendMessage({ type: 'UZ_PROGRESS', state: snapshot() });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* эътибор бермаймиз */ }
  }

  function snapshot() {
    return { ...state };
  }

  /**
   * Иш ҳудудини аниқлайди. Фойдаланувчи матн белгилаган бўлса ва шуни
   * сўраган бўлса - фақат ўша Range, акс ҳолда созламадаги қамров.
   */
  function resolveTarget(ctx) {
    if (ctx && ctx.range) {
      return { root: self.UZ_EXTRACT.rangeRoot(ctx.range), range: ctx.range };
    }
    const root = settingsCache.scope === 'page'
      ? document.body
      : self.UZ_EXTRACT.pickRoot();
    return { root, range: null };
  }

  function buildBatches(items, maxChars) {
    const batches = [];
    let current = [];
    let size = 0;
    for (const item of items) {
      if (current.length && (size + item.core.length > maxChars || current.length >= 40)) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += item.core.length;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  function rememberOriginal(item) {
    originals.push({ node: item.node, raw: item.raw });
  }

  function applyTranslation(item, text) {
    if (!item.node.isConnected) return;
    item.node.nodeValue = item.lead + text + item.trail;
  }

  async function runPool(tasks, limit) {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (index < tasks.length) {
        const current = tasks[index];
        index += 1;
        await current();
      }
    });
    await Promise.all(workers);
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!response) return reject(new Error('Фон жараёнидан жавоб келмади.'));
        if (!response.ok) {
          const error = new Error(response.error);
          error.aborted = Boolean(response.aborted);
          return reject(error);
        }
        return resolve(response);
      });
    });
  }

  // ── Амаллар ────────────────────────────────────────────────────────────────

  async function runTranslit(ctx) {
    const { root, range } = resolveTarget(ctx);
    const items = self.UZ_EXTRACT.collectNodes(root, range);
    if (!items.length) throw new Error('Таржима қилиш учун матн топилмади.');

    state.total = items.length;
    state.done = 0;

    const CHUNK = 300;
    for (let i = 0; i < items.length; i += CHUNK) {
      if (ctx.cancelled) return;
      const slice = items.slice(i, i + CHUNK);
      for (const item of slice) {
        rememberOriginal(item);
        applyTranslation(item, self.UZ_TRANSLIT.toCyrillic(item.core));
      }
      state.done = Math.min(i + CHUNK, items.length);
      showBadge(`Транслитерация: ${state.done}/${state.total}`, {
        progress: state.done / state.total,
      });
      publish();
      // Асосий оқимни бўшатиб турамиз
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    state.translated = true;
  }

  async function runLlm(ctx) {
    const { root, range } = resolveTarget(ctx);
    const items = self.UZ_EXTRACT.collectNodes(root, range);
    if (!items.length) throw new Error('Таржима қилиш учун матн топилмади.');

    const batches = buildBatches(items, settingsCache.batchChars);
    state.total = batches.length;
    state.done = 0;

    items.forEach(rememberOriginal);
    showBadge(`Таржима: 0/${state.total}`, { progress: 0 });

    const failures = [];
    let attempted = 0;

    const tasks = batches.map((batch) => async () => {
      // Бекор қилинган бўлса - бу пакетни умуман юбормаймиз
      if (ctx.cancelled) return;
      attempted += 1;
      try {
        const response = await sendToBackground({
          type: 'UZ_TRANSLATE_BATCH',
          runId: ctx.id,
          force: ctx.force,
          segments: batch.map((item) => item.core),
        });
        // Жавоб келгунча бекор қилинган бўлиши мумкин - натижани қўлламаймиз
        if (ctx.cancelled) return;
        state.fromCache += response.fromCache || 0;
        state.fresh += response.fresh || 0;
        batch.forEach((item, i) => applyTranslation(item, response.segments[i]));
      } catch (err) {
        if (!ctx.cancelled && !err.aborted) failures.push(err.message);
      } finally {
        state.done += 1;
        if (!ctx.cancelled) {
          showBadge(`Таржима: ${state.done}/${state.total}`, {
            progress: state.done / state.total,
          });
        }
        publish();
      }
    });

    await runPool(tasks, Math.max(1, settingsCache.concurrency));

    state.translated = true;
    if (ctx.cancelled) return;

    if (attempted > 0 && failures.length === attempted) {
      throw new Error(failures[0] || 'Барча сўровлар муваффақиятсиз тугади.');
    }
    if (failures.length) {
      state.error = `${failures.length} та бўлак таржима қилинмади: ${failures[0]}`;
    }
  }

  /**
   * Хулоса учун матн йиғади. Бу ерда тармоққа чиқилмайди: сўровни popup
   * юборади, чунки саҳифада бир нечта фрейм бўлиши мумкин ва хулоса панели
   * иккиламчи фреймда эмас, юқори фреймда кўрсатилиши керак.
   */
  function collectText(onlySelection) {
    const range = onlySelection ? self.UZ_EXTRACT.getSelectionRange() : null;
    if (onlySelection && !range) throw new Error('Белгиланган матн топилмади.');
    const { root } = resolveTarget(range ? { range } : null);
    return range ? range.toString().trim() : self.UZ_EXTRACT.readableText(root);
  }

  /** Жорий сеансни тўхтатади. Таржима қилиб улгурган матн жойида қолади. */
  function cancelRun() {
    if (!activeRun || activeRun.cancelled) return false;
    activeRun.cancelled = true;

    // background'даги учиб турган fetch'ларни узамиз
    try {
      const result = chrome.runtime.sendMessage({ type: 'UZ_ABORT', runId: activeRun.id });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* эътибор бермаймиз */ }

    state.status = 'cancelled';
    showBadge('Бекор қилинди', { autoHideMs: 3000 });
    publish();
    return true;
  }

  function revert() {
    for (const entry of originals) {
      if (entry.node.isConnected) entry.node.nodeValue = entry.raw;
    }
    originals = [];
    state.translated = false;
    state.status = 'idle';
    state.mode = null;
    state.done = 0;
    state.total = 0;
    state.error = null;
    hideBadge();
    publish();
  }

  function doneLabel() {
    if (state.error) return state.error;
    if (state.fromCache > 0 && state.fresh === 0) return 'Тайёр - тўлиқ кэшдан';
    if (state.fromCache > 0) return `Тайёр - ${state.fromCache} та бўлак кэшдан`;
    return 'Тайёр';
  }

  async function run(mode, options = {}) {
    if (state.status === 'running') {
      throw new Error('Аввалги амал ҳали тугамади.');
    }
    if (mode !== 'summary' && state.translated) {
      // Икки марта таржима қилмаслик учун - аввал аслига қайтарамиз
      revert();
    }

    await loadSettings();

    // Белгиланган матн run бошида олинади: кейинроқ DOM ўзгарса Range бузилади
    let range = null;
    if (options.onlySelection) {
      range = self.UZ_EXTRACT.getSelectionRange();
      if (!range) throw new Error('Белгиланган матн топилмади.');
    }

    const ctx = {
      id: ++runCounter,
      cancelled: false,
      force: Boolean(options.force),
      range,
    };
    activeRun = ctx;

    state.status = 'running';
    state.mode = mode;
    state.error = null;
    state.fromCache = 0;
    state.fresh = 0;
    publish();

    try {
      if (mode === 'translit') await runTranslit(ctx);
      else if (mode === 'llm') await runLlm(ctx);
      else throw new Error(`Номаълум режим: ${mode}`);

      if (ctx.cancelled) {
        state.status = 'cancelled';
        return;
      }

      state.status = 'done';
      showBadge(doneLabel(), {
        progress: 1,
        error: Boolean(state.error),
        autoHideMs: state.error ? 8000 : 2500,
      });
    } catch (err) {
      // Бекор қилиш хато эмас
      if (ctx.cancelled || err.aborted) {
        state.status = 'cancelled';
        return;
      }
      state.status = 'error';
      state.error = err.message;
      showBadge(err.message, { error: true, autoHideMs: 10000 });
      throw err;
    } finally {
      if (activeRun === ctx) activeRun = null;
      publish();
    }
  }

  // ── Popup билан алоқа ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'UZ_PING') {
      loadSettings()
        .then(() => {
          const { root } = resolveTarget(null);
          const sample = self.UZ_EXTRACT.readableText(root).slice(0, 8000);
          const selection = self.UZ_EXTRACT.getSelectionRange();
          const selectionText = selection ? selection.toString().trim() : '';
          sendResponse({
            ok: true,
            state: snapshot(),
            detection: self.UZ_DETECT.detect(selectionText || sample),
            chars: sample.length,
            selection: selection ? { chars: selectionText.length } : null,
          });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (msg.type === 'UZ_STATE') {
      sendResponse({ ok: true, state: snapshot() });
      return false;
    }

    if (msg.type === 'UZ_REVERT') {
      revert();
      sendResponse({ ok: true, state: snapshot() });
      return false;
    }

    if (msg.type === 'UZ_RUN') {
      run(msg.mode, { force: msg.force, onlySelection: msg.onlySelection })
        .then(() => sendResponse({ ok: true, state: snapshot() }))
        .catch((err) => sendResponse({ ok: false, error: err.message, state: snapshot() }));
      return true;
    }

    if (msg.type === 'UZ_CANCEL') {
      const stopped = cancelRun();
      sendResponse({ ok: true, stopped, state: snapshot() });
      return false;
    }

    if (msg.type === 'UZ_SHOW_SUMMARY') {
      if (state.summary) showPanel(state.summary);
      sendResponse({ ok: true, hasSummary: Boolean(state.summary) });
      return false;
    }

    // Хулоса учун матн бериш. Тармоқ сўровини popup юборади.
    if (msg.type === 'UZ_COLLECT_TEXT') {
      loadSettings()
        .then(() => {
          const text = collectText(Boolean(msg.onlySelection));
          sendResponse({ ok: true, text });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    // Тайёр хулосани кўрсатиш. Ҳар доим юқори фреймга юборилади.
    if (msg.type === 'UZ_SHOW_TEXT') {
      state.summary = msg.text;
      showPanel(msg.text);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'UZ_BADGE') {
      loadSettings().then(() => {
        if (msg.text) {
          showBadge(msg.text, {
            error: Boolean(msg.error),
            autoHideMs: msg.autoHideMs || 0,
          });
        } else {
          hideBadge();
        }
        sendResponse({ ok: true });
      });
      return true;
    }

    return undefined;
  });
})();
