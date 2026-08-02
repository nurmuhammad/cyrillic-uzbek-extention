// Popup. Content script'ни талаб бўлганда инжекция қилади ва амалларни
// ишга туширади. Ҳеч қандай API-калит бу ерда ишлатилмайди.

const CONTENT_FILES = [
  'src/content/translit.js',
  'src/content/detect.js',
  'src/content/extract.js',
  'src/content/content.js',
];

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
};

const ACTION_BUTTONS = [els.llm, els.translit, els.summary, els.revert, els.showSummary];

let tabId = null;
let hasKey = false;
let busy = false;

function setStatus(text, isError = false) {
  els.status.textContent = text || '';
  els.status.classList.toggle('error', Boolean(isError));
}

/** Ишлаётганда амал тугмалари ўчади, «Бекор қилиш» эса аксинча пайдо бўлади. */
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

function sendToTab(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!response) return reject(new Error('Саҳифадан жавоб келмади.'));
      if (!response.ok) return reject(new Error(response.error || 'Хато юз берди.'));
      return resolve(response);
    });
  });
}

async function ensureInjected() {
  try {
    return await sendToTab({ type: 'UZ_PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return sendToTab({ type: 'UZ_PING' });
  }
}

function renderDetection(detection) {
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

function renderSelection(selection) {
  const has = Boolean(selection && selection.chars > 0);
  els.selRow.hidden = !has;
  if (!has) {
    els.onlySelection.checked = false;
    return;
  }
  els.selChars.textContent = String(selection.chars);
  // Атайлаб белгиланган матн бўлса - стандарт ҳолат «фақат шуни таржима қил»,
  // чунки бу энг арзон вариант. Фойдаланувчи белгини олиб ташлаши мумкин.
  els.onlySelection.checked = true;
}

function describeState(state) {
  if (state.status === 'running') {
    const label = {
      llm: 'Таржима', translit: 'Транслитерация', summary: 'Хулоса',
    }[state.mode] || 'Ишланмоқда';
    return state.total > 1 ? `${label}: ${state.done}/${state.total}` : `${label}…`;
  }
  if (state.status === 'cancelled') return 'Бекор қилинди';
  if (state.status === 'error') return state.error || 'Хато';
  if (state.status === 'done') {
    if (state.error) return state.error;
    if (state.fromCache > 0 && state.fresh === 0) return 'Тайёр - тўлиқ кэшдан';
    if (state.fromCache > 0) return `Тайёр - ${state.fromCache} та бўлак кэшдан`;
    return 'Тайёр';
  }
  return '';
}

async function run(mode) {
  if (busy) return;
  setBusy(true);
  setStatus('Ишга туширилмоқда…');
  try {
    await ensureInjected();
    const response = await sendToTab({
      type: 'UZ_RUN',
      mode,
      force: els.force.checked,
      onlySelection: !els.selRow.hidden && els.onlySelection.checked,
    });
    setStatus(describeState(response.state) || 'Тайёр');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

els.llm.addEventListener('click', () => run('llm'));
els.translit.addEventListener('click', () => run('translit'));
els.summary.addEventListener('click', () => run('summary'));

els.cancel.addEventListener('click', async () => {
  els.cancel.disabled = true;
  setStatus('Тўхтатилмоқда…');
  try {
    await sendToTab({ type: 'UZ_CANCEL' });
  } catch (err) {
    setStatus(err.message, true);
  }
});

els.revert.addEventListener('click', async () => {
  setBusy(true);
  try {
    await sendToTab({ type: 'UZ_REVERT' });
    setStatus('Асл матн қайтарилди.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
});

els.showSummary.addEventListener('click', async () => {
  setBusy(true);
  try {
    const response = await sendToTab({ type: 'UZ_SHOW_SUMMARY' });
    setStatus(response.hasSummary ? 'Хулоса саҳифада кўрсатилди.' : 'Ҳали хулоса қилинмаган.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
});

els.options.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'UZ_PROGRESS' && msg.state) {
    setStatus(describeState(msg.state), msg.state.status === 'error');
  }
});

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

  if (!hasKey) {
    setStatus('API-калит киритилмаган - фақат транслитерация ишлайди.');
  }
  applyKeyGate();

  try {
    const response = await ensureInjected();
    renderDetection(response.detection);
    renderSelection(response.selection);

    // Popup ёпилиб очилган бўлса, иш ҳали давом этаётган бўлиши мумкин
    if (response.state.status === 'running') {
      setBusy(true);
    }
    const text = describeState(response.state);
    if (text) setStatus(text, response.state.status === 'error');
  } catch (err) {
    els.detect.textContent = 'Саҳифага уланиб бўлмади.';
    setStatus(err.message, true);
    for (const btn of ACTION_BUTTONS) btn.disabled = true;
  }
})();
