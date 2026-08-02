// Popup. Саҳифа устидаги амаллар src/shared/orchestrate.js да - худди шу
// модулни background ҳам ишлатади (контекст меню ва қисқартма учун).
// Ҳеч қандай API-калит бу ерда ишлатилмайди.

import {
  TOP_FRAME,
  attach,
  runTranslate as orchestrateTranslate,
  revertAll,
  cancelAll,
  collectSummaryText,
  showSummary,
  badge,
  sendToFrame,
} from '../shared/orchestrate.js';

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
let frameSet = { frames: [], mainFrameId: TOP_FRAME, selectionFrameId: null };
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

function usingSelection() {
  return !els.selRow.hidden
    && els.onlySelection.checked
    && frameSet.selectionFrameId !== null;
}

// ── Кўрсатиш ───────────────────────────────────────────────────────────────

function renderDetection() {
  const source = frameSet.frames.find(
    (f) => f.frameId === (frameSet.selectionFrameId ?? frameSet.mainFrameId),
  ) || frameSet.frames[0];

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
  const inner = frameSet.frames.filter((f) => f.frameId !== TOP_FRAME && f.chars > 0);
  els.frames.hidden = inner.length === 0;
  if (inner.length) {
    els.frames.textContent = `Саҳифада ${inner.length} та iframe топилди, улар ҳам таржима қилинади.`;
  }
}

function renderSelection() {
  const info = frameSet.frames.find((f) => f.frameId === frameSet.selectionFrameId);
  els.selRow.hidden = !info;
  if (!info) {
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

async function translate(mode) {
  if (busy) return;
  setBusy(true);
  progressByFrame.clear();
  setStatus('Ишга туширилмоқда…');

  try {
    frameSet = await attach(tabId);
    const result = await orchestrateTranslate(tabId, frameSet, {
      mode,
      force: els.force.checked,
      onlySelection: usingSelection(),
    });

    if (!result.started) setStatus('Ҳеч бир фреймда таржима қилинмади.', true);
    else renderProgress();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

async function summarize() {
  if (busy) return;
  setBusy(true);
  setStatus('Матн йиғилмоқда…');

  try {
    frameSet = await attach(tabId);
    const text = await collectSummaryText(tabId, frameSet, usingSelection());
    if (text.length < 80) throw new Error('Хулоса қилиш учун матн жуда кам.');

    summaryRunId = `sum-${Date.now()}`;
    setStatus('Хулоса тайёрланмоқда…');
    await badge(tabId, 'Хулоса тайёрланмоқда…');

    const response = await chrome.runtime.sendMessage({
      type: 'UZ_SUMMARIZE',
      runId: summaryRunId,
      text,
    });

    if (!response?.ok) {
      if (response?.aborted) {
        setStatus('Бекор қилинди');
        await badge(tabId, '');
        return;
      }
      throw new Error(response?.error || 'Хулоса тайёрланмади.');
    }

    await showSummary(tabId, response.summary);
    await badge(tabId, '');
    setStatus('Хулоса саҳифада кўрсатилди.');
  } catch (err) {
    setStatus(err.message, true);
    await badge(tabId, err.message, { error: true, autoHideMs: 8000 });
  } finally {
    summaryRunId = null;
    setBusy(false);
  }
}

async function cancel() {
  els.cancel.disabled = true;
  setStatus('Тўхтатилмоқда…');

  if (summaryRunId) {
    try {
      await chrome.runtime.sendMessage({ type: 'UZ_ABORT', runId: summaryRunId });
    } catch { /* эътибор бермаймиз */ }
  }
  await cancelAll(tabId, frameSet);
}

// ── Тугмалар ───────────────────────────────────────────────────────────────

els.llm.addEventListener('click', () => translate('llm'));
els.translit.addEventListener('click', () => translate('translit'));
els.summary.addEventListener('click', () => summarize());
els.cancel.addEventListener('click', () => cancel());

els.revert.addEventListener('click', async () => {
  setBusy(true);
  try {
    await revertAll(tabId, frameSet);
    progressByFrame.clear();
    setStatus('Асл матн қайтарилди.');
  } finally {
    setBusy(false);
  }
});

els.showSummary.addEventListener('click', async () => {
  setBusy(true);
  try {
    const response = await sendToFrame(tabId, TOP_FRAME, { type: 'UZ_SHOW_SUMMARY' });
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
    frameSet = await attach(tabId);
    renderDetection();
    renderFrames();
    renderSelection();

    // Popup ёпилиб очилган бўлса, иш ҳали давом этаётган бўлиши мумкин
    for (const frame of frameSet.frames) {
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
