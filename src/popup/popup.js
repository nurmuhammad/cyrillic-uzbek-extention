// Popup. Content script'ни ҳамма фреймга инжекция қилади ва амалларни
// ишга туширади. Ҳеч қандай API-калит бу ерда ишлатилмайди.
//
// Нима учун фреймлар билан овора бўламиз: кўп сайт (масалан t.me) асосий
// матнни iframe ичида кўрсатади. Фақат юқори фреймга юкланса, ўша матн
// таржима қилинмай қолади.

const CONTENT_FILES = [
  'src/content/translit.js',
  'src/content/detect.js',
  'src/content/extract.js',
  'src/content/content.js',
];

const TOP_FRAME = 0;
const ALL_URLS = { origins: ['<all_urls>'] };

const els = {
  detect: document.getElementById('detect'),
  status: document.getElementById('status'),
  model: document.getElementById('model'),
  llm: document.getElementById('btn-llm'),
  translit: document.getElementById('btn-translit'),
  summary: document.getElementById('btn-summary'),
  cancel: document.getElementById('btn-cancel'),
  revert: document.getElementById('btn-revert'),
  showSummary: document.getElementById('btn-show-summary'),
  options: document.getElementById('open-options'),
  selRow: document.getElementById('sel-row'),
  selChars: document.getElementById('sel-chars'),
  onlySelection: document.getElementById('only-selection'),
  forceRow: document.getElementById('force-row'),
  force: document.getElementById('force'),
  frames: document.getElementById('frames'),
  grant: document.getElementById('btn-grant'),
};

const ACTION_BUTTONS = [els.llm, els.translit, els.summary, els.revert, els.showSummary];

let tabId = null;
let hasKey = false;
let busy = false;

/** Content script тирик бўлган фреймлар: [{frameId, chars, selection, detection}] */
let frames = [];
let mainFrameId = TOP_FRAME;
let selectionFrameId = null;
let summaryRunId = null;

const progressByFrame = new Map();

// ── Ёрдамчилар ──────────────────────────────────────────────────────────────

function setStatus(text, isError = false) {
  els.status.textContent = text || '';
  els.status.classList.toggle('error', Boolean(isError));
}

function setBusy(value) {
  busy = value;
  for (const btn of ACTION_BUTTONS) btn.disabled = value;
  els.onlySelection.disabled = value;
  els.force.disabled = value;
  els.selRow.classList.toggle('disabled', value);
  els.forceRow.classList.toggle('disabled', value);
  els.cancel.hidden = !value;
  els.cancel.disabled = false;
  if (!value) applyKeyGate();
}

function applyKeyGate() {
  if (!hasKey) {
    els.llm.disabled = true;
    els.summary.disabled = true;
  }
}

function sendToFrame(frameId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!response) return reject(new Error('Фреймдан жавоб келмади.'));
      if (!response.ok) return reject(new Error(response.error || 'Хато юз берди.'));
      return resolve(response);
    });
  });
}

/** Хатони ютиб юборадиган вариант - фреймларга кўп сўров юборганда керак. */
async function trySendToFrame(frameId, message) {
  try {
    return await sendToFrame(frameId, message);
  } catch {
    return null;
  }
}

// ── Инжекция ва фреймларни аниқлаш ─────────────────────────────────────────

async function injectAll() {
  // Гуард байроғи борлиги учун қайта инжекция зарарсиз
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES,
    });
    return results.map((r) => r.frameId).filter((id) => id !== undefined);
  } catch {
    // allFrames рухсат этилмаса - ҳеч бўлмаса юқори фреймга юклаймиз
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return [TOP_FRAME];
  }
}

async function collectFrames() {
  const ids = await injectAll();

  const infos = await Promise.all(ids.map(async (frameId) => {
    const response = await trySendToFrame(frameId, { type: 'UZ_PING' });
    return response ? { frameId, ...response } : null;
  }));

  frames = infos.filter(Boolean).filter((f) => f.chars > 0 || f.frameId === TOP_FRAME);
  if (!frames.length) throw new Error('Саҳифага уланиб бўлмади.');

  // Асосий матн энг кўп бўлган фрейм - хулоса ва тил тахмини шундан олинади
  mainFrameId = frames.reduce((best, f) => (f.chars > best.chars ? f : best), frames[0]).frameId;

  const withSelection = frames.find((f) => f.selection && f.selection.chars > 0);
  selectionFrameId = withSelection ? withSelection.frameId : null;

  return frames;
}

function frameTargets(useSelection) {
  if (useSelection && selectionFrameId !== null) return [selectionFrameId];
  return frames.map((f) => f.frameId);
}

function usingSelection() {
  return !els.selRow.hidden && els.onlySelection.checked && selectionFrameId !== null;
}

// ── Кўрсатиш ───────────────────────────────────────────────────────────────

function renderDetection() {
  const source = frames.find((f) => f.frameId === (selectionFrameId ?? mainFrameId))
    || frames[0];
  const detection = source.detection;

  els.detect.className = `detect hint-${detection.hint}`;
  els.detect.textContent = detection.label;

  if (detection.hint === 'translit') {
    els.translit.classList.add('primary');
    els.llm.classList.remove('primary');
  } else {
    els.llm.classList.add('primary');
    els.translit.classList.remove('primary');
  }
}

function renderFrames() {
  const inner = frames.filter((f) => f.frameId !== TOP_FRAME && f.chars > 0);
  if (!inner.length) {
    els.frames.hidden = true;
    return;
  }
  els.frames.hidden = false;
  els.frames.textContent = `Саҳифада ${inner.length} та iframe топилди, улар ҳам таржима қилинади.`;
}

function renderSelection() {
  const info = frames.find((f) => f.frameId === selectionFrameId);
  const has = Boolean(info);
  els.selRow.hidden = !has;
  if (!has) {
    els.onlySelection.checked = false;
    return;
  }
  els.selChars.textContent = String(info.selection.chars);
  // Атайлаб белгиланган матн бўлса - стандарт ҳолат «фақат шуни таржима қил»,
  // чунки бу энг арзон вариант.
  els.onlySelection.checked = true;
}

function renderProgress() {
  const states = [...progressByFrame.values()];
  if (!states.length) return;

  const running = states.find((s) => s.status === 'running');
  if (running) {
    const label = running.mode === 'translit' ? 'Транслитерация' : 'Таржима';
    const done = states.reduce((n, s) => n + (s.done || 0), 0);
    const total = states.reduce((n, s) => n + (s.total || 0), 0);
    setStatus(total > 1 ? `${label}: ${done}/${total}` : `${label}…`);
    return;
  }

  if (states.some((s) => s.status === 'cancelled')) {
    setStatus('Бекор қилинди');
    return;
  }

  const failed = states.filter((s) => s.status === 'error');
  if (failed.length === states.length) {
    setStatus(failed[0].error || 'Хато', true);
    return;
  }

  const fromCache = states.reduce((n, s) => n + (s.fromCache || 0), 0);
  const fresh = states.reduce((n, s) => n + (s.fresh || 0), 0);
  if (fromCache > 0 && fresh === 0) setStatus('Тайёр - тўлиқ кэшдан');
  else if (fromCache > 0) setStatus(`Тайёр - ${fromCache} та бўлак кэшдан`);
  else setStatus('Тайёр');
}

// ── Амаллар ────────────────────────────────────────────────────────────────

async function runTranslate(mode) {
  if (busy) return;
  setBusy(true);
  progressByFrame.clear();
  setStatus('Ишга туширилмоқда…');

  try {
    await collectFrames();
    const useSelection = usingSelection();
    const targets = frameTargets(useSelection);

    const results = await Promise.all(targets.map((frameId) => trySendToFrame(frameId, {
      type: 'UZ_RUN',
      mode,
      force: els.force.checked,
      onlySelection: useSelection,
    })));

    const ok = results.filter(Boolean);
    if (!ok.length) {
      setStatus('Ҳеч бир фреймда таржима қилинмади.', true);
    } else {
      renderProgress();
    }
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

async function runSummary() {
  if (busy) return;
  setBusy(true);
  setStatus('Матн йиғилмоқда…');

  try {
    await collectFrames();
    const useSelection = usingSelection();
    const sourceFrame = useSelection ? selectionFrameId : mainFrameId;

    const collected = await sendToFrame(sourceFrame, {
      type: 'UZ_COLLECT_TEXT',
      onlySelection: useSelection,
    });

    const text = (collected.text || '').trim();
    if (text.length < 80) throw new Error('Хулоса қилиш учун матн жуда кам.');

    summaryRunId = `sum-${Date.now()}`;
    setStatus('Хулоса тайёрланмоқда…');
    await trySendToFrame(TOP_FRAME, { type: 'UZ_BADGE', text: 'Хулоса тайёрланмоқда…' });

    const response = await chrome.runtime.sendMessage({
      type: 'UZ_SUMMARIZE',
      runId: summaryRunId,
      text,
    });

    if (!response?.ok) {
      if (response?.aborted) {
        setStatus('Бекор қилинди');
        await trySendToFrame(TOP_FRAME, { type: 'UZ_BADGE', text: '' });
        return;
      }
      throw new Error(response?.error || 'Хулоса тайёрланмади.');
    }

    // Панель ҳар доим юқори фреймда: iframe ичида у қисилиб қолади
    await trySendToFrame(TOP_FRAME, { type: 'UZ_SHOW_TEXT', text: response.summary });
    await trySendToFrame(TOP_FRAME, { type: 'UZ_BADGE', text: '' });
    setStatus('Хулоса саҳифада кўрсатилди.');
  } catch (err) {
    setStatus(err.message, true);
    await trySendToFrame(TOP_FRAME, { type: 'UZ_BADGE', text: err.message, error: true, autoHideMs: 8000 });
  } finally {
    summaryRunId = null;
    setBusy(false);
  }
}

async function cancelAll() {
  els.cancel.disabled = true;
  setStatus('Тўхтатилмоқда…');

  if (summaryRunId) {
    try {
      await chrome.runtime.sendMessage({ type: 'UZ_ABORT', runId: summaryRunId });
    } catch { /* эътибор бермаймиз */ }
  }

  await Promise.all(frames.map((f) => trySendToFrame(f.frameId, { type: 'UZ_CANCEL' })));
}

// ── Тугмалар ───────────────────────────────────────────────────────────────

els.llm.addEventListener('click', () => runTranslate('llm'));
els.translit.addEventListener('click', () => runTranslate('translit'));
els.summary.addEventListener('click', () => runSummary());
els.cancel.addEventListener('click', () => cancelAll());

els.revert.addEventListener('click', async () => {
  setBusy(true);
  try {
    await Promise.all(frames.map((f) => trySendToFrame(f.frameId, { type: 'UZ_REVERT' })));
    progressByFrame.clear();
    setStatus('Асл матн қайтарилди.');
  } finally {
    setBusy(false);
  }
});

els.showSummary.addEventListener('click', async () => {
  setBusy(true);
  try {
    const response = await sendToFrame(TOP_FRAME, { type: 'UZ_SHOW_SUMMARY' });
    setStatus(response.hasSummary ? 'Хулоса саҳифада кўрсатилди.' : 'Ҳали хулоса қилинмаган.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
});

els.grant.addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request(ALL_URLS);
    if (granted) {
      els.grant.hidden = true;
      setStatus('Рухсат берилди. Таржимани қайта ишга туширинг.');
    } else {
      setStatus('Рухсат берилмади.');
    }
  } catch (err) {
    setStatus(err.message, true);
  }
});

els.options.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'UZ_PROGRESS' && msg.state) {
    progressByFrame.set(sender.frameId ?? TOP_FRAME, msg.state);
    renderProgress();
  }
});

// ── Ишга тушиш ─────────────────────────────────────────────────────────────

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  const url = tab?.url || '';
  if (!tabId || /^(chrome|edge|about|devtools|chrome-extension):/i.test(url)) {
    els.detect.textContent = 'Бу саҳифада кенгайтма ишламайди.';
    setBusy(true);
    els.cancel.hidden = true;
    return;
  }

  try {
    const key = await chrome.runtime.sendMessage({ type: 'UZ_CHECK_KEY' });
    hasKey = Boolean(key?.hasKey);
    els.model.textContent = key?.model || '';
  } catch {
    hasKey = false;
  }

  if (!hasKey) setStatus('API-калит киритилмаган - фақат транслитерация ишлайди.');
  applyKeyGate();

  // Бошқа доменли iframe'ларга кириш учун қўшимча рухсат керак
  try {
    els.grant.hidden = await chrome.permissions.contains(ALL_URLS);
  } catch {
    els.grant.hidden = true;
  }

  try {
    await collectFrames();
    renderDetection();
    renderFrames();
    renderSelection();

    // Popup ёпилиб очилган бўлса, иш ҳали давом этаётган бўлиши мумкин
    for (const frame of frames) {
      if (frame.state) progressByFrame.set(frame.frameId, frame.state);
      if (frame.state?.status === 'running') setBusy(true);
    }
    renderProgress();
  } catch (err) {
    els.detect.textContent = 'Саҳифага уланиб бўлмади.';
    setStatus(err.message, true);
    for (const btn of ACTION_BUTTONS) btn.disabled = true;
  }
})();
