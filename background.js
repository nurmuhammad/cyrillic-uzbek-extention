// Service worker. Барча тармоқ сўровлари шу ерда - content script'дан
// fetch қилинса саҳифанинг CORS сиёсати халақит беради, шунингдек API-калит
// саҳифа контекстига умуман тушмаслиги керак.

import { getSettings } from './src/shared/config.js';
import {
  translateSegments,
  completeText,
  OpenRouterError,
} from './src/shared/openrouter.js';
import {
  translateSystemPrompt,
  blockSystemPrompt,
  summarySystemPrompt,
  reduceSystemPrompt,
} from './src/shared/prompts.js';
import {
  attach,
  runTranslate,
  revertAll,
  badge,
} from './src/shared/orchestrate.js';

// ── Кэш ────────────────────────────────────────────────────────────────────
//
// Икки қаватли: хотирадаги Map (тез, лекин service worker уйқуга кетса
// йўқолади) ва chrome.storage.local (сеанслар орасида сақланади). Иккинчиси
// туфайли аввал таржима қилинган саҳифа қайта очилганда моделга пул
// тўланмайди - ҳамма бўлак кэшдан келади.
//
// Калит = SHA-256(модель + матн) нинг биринчи 12 байти. Моделни калитга
// қўшиш шарт: бошқа модель бошқача таржима қилади.

const MEM_LIMIT = 2000;
const memory = new Map();

const STORE_PREFIX = 'tc:';
const STORE_LIMIT = 15000;
const COUNT_KEY = '__tcCount';

async function hashKey(model, text) {
  const data = new TextEncoder().encode(`${model}|${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest).subarray(0, 12);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return STORE_PREFIX + hex;
}

function memSet(key, value) {
  if (memory.size >= MEM_LIMIT) {
    const drop = Math.floor(MEM_LIMIT / 4);
    let i = 0;
    for (const k of memory.keys()) {
      memory.delete(k);
      if (++i >= drop) break;
    }
  }
  memory.set(key, value);
}

/** Калитлар бўйича ўқийди. Топилмаганлари `undefined` бўлиб қолади. */
async function cacheRead(keys) {
  const values = new Array(keys.length).fill(undefined);
  const missing = [];

  keys.forEach((key, i) => {
    const hit = memory.get(key);
    if (hit !== undefined) values[i] = hit;
    else missing.push(key);
  });

  if (missing.length) {
    const stored = await chrome.storage.local.get(missing);
    keys.forEach((key, i) => {
      if (values[i] !== undefined) return;
      const entry = stored[key];
      if (entry && typeof entry.t === 'string') {
        values[i] = entry.t;
        memSet(key, entry.t);
      }
    });
  }

  return values;
}

/**
 * @param {string[]} sources - асл матн. Тўлиқ эмас, биринчи 120 белгиси
 *   сақланади: созламалардаги кэш рўйхатида ёзувни таниб олиш учун етарли,
 *   лекин жойни икки баробар эгалламайди.
 */
async function cacheWrite(keys, values, sources = []) {
  if (!keys.length) return;
  const now = Date.now();
  const patch = {};
  keys.forEach((key, i) => {
    patch[key] = { s: String(sources[i] || '').slice(0, 120), t: values[i], u: now };
    memSet(key, values[i]);
  });
  await chrome.storage.local.set(patch);

  const stored = await chrome.storage.local.get(COUNT_KEY);
  const next = (stored[COUNT_KEY] || 0) + keys.length;
  if (next > STORE_LIMIT) await pruneCache();
  else await chrome.storage.local.set({ [COUNT_KEY]: next });
}

/**
 * Чегарадан ошганда эски ёзувларни ташлайди.
 * Тартиб - ёзилган вақт бўйича (FIFO). Ўқилган вақт янгиланмайди: ҳар
 * ўқишда storage'га ёзиш кэшнинг маъносини йўқотган бўларди.
 */
async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([key, value]) => key.startsWith(STORE_PREFIX) && value && typeof value.t === 'string')
    .sort((a, b) => (a[1].u || 0) - (b[1].u || 0));

  const keep = Math.floor(STORE_LIMIT * 0.7);
  const drop = Math.max(0, entries.length - keep);
  if (drop > 0) {
    await chrome.storage.local.remove(entries.slice(0, drop).map(([key]) => key));
  }
  await chrome.storage.local.set({ [COUNT_KEY]: entries.length - drop });
}

async function cacheStats() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(STORE_PREFIX));
  let bytes = 0;
  try {
    bytes = await chrome.storage.local.getBytesInUse(keys);
  } catch { /* getBytesInUse ҳамма ерда мавжуд эмас */ }
  return { count: keys.length, bytes };
}

/** Созламалардаги кэш рўйхати учун. Янгидан эскига қараб тартибланади. */
async function cacheList({ query = '', limit = 200 } = {}) {
  const all = await chrome.storage.local.get(null);
  const needle = String(query || '').trim().toLowerCase();

  const entries = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(STORE_PREFIX)) continue;
    if (!value || typeof value.t !== 'string') continue;
    if (needle && !`${value.s || ''} ${value.t}`.toLowerCase().includes(needle)) continue;
    entries.push({ key, s: value.s || '', t: value.t, u: value.u || 0 });
  }

  entries.sort((a, b) => b.u - a.u);
  return { entries: entries.slice(0, limit), matched: entries.length };
}

async function cacheDelete(keys) {
  const valid = (keys || []).filter(
    (key) => typeof key === 'string' && key.startsWith(STORE_PREFIX),
  );
  if (!valid.length) return 0;

  await chrome.storage.local.remove(valid);
  for (const key of valid) memory.delete(key);

  const stored = await chrome.storage.local.get(COUNT_KEY);
  const next = Math.max(0, (stored[COUNT_KEY] || 0) - valid.length);
  await chrome.storage.local.set({ [COUNT_KEY]: next });
  return valid.length;
}

async function cacheClear() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(STORE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ [COUNT_KEY]: 0 });
  memory.clear();
  return keys.length;
}

// ── Харажат ҳисоби ─────────────────────────────────────────────────────────
//
// OpenRouter ҳар жавобда токен сонини қайтаради, баъзи моделларда нархни ҳам.
// Шуни кунлар кесимида йиғиб борамиз - фойдаланувчи қанча сарфлаётганини
// кўриб турсин.

const USAGE_KEY = '__usage';
const USAGE_DAYS = 60;

function emptyBucket() {
  return { input: 0, output: 0, cost: 0, requests: 0 };
}

function addTo(bucket, usage) {
  bucket.input += usage.input;
  bucket.output += usage.output;
  bucket.cost += usage.cost;
  bucket.requests += 1;
}

async function readUsage() {
  const stored = await chrome.storage.local.get(USAGE_KEY);
  const data = stored[USAGE_KEY];
  if (data && data.total && data.days) return data;
  return { total: emptyBucket(), days: {} };
}

async function recordUsage(usage) {
  if (!usage || (!usage.input && !usage.output)) return;

  const today = new Date().toISOString().slice(0, 10);
  const data = await readUsage();

  const day = data.days[today] || emptyBucket();
  addTo(data.total, usage);
  addTo(day, usage);
  data.days[today] = day;

  // Эски кунларни ташлаб турамиз, акс ҳолда объект чексиз ўсади
  const keys = Object.keys(data.days).sort();
  while (keys.length > USAGE_DAYS) delete data.days[keys.shift()];

  await chrome.storage.local.set({ [USAGE_KEY]: data });
}

async function usageStats() {
  const data = await readUsage();
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);

  const month = emptyBucket();
  for (const [day, bucket] of Object.entries(data.days)) {
    if (!day.startsWith(monthPrefix)) continue;
    month.input += bucket.input;
    month.output += bucket.output;
    month.cost += bucket.cost;
    month.requests += bucket.requests;
  }

  return {
    today: data.days[today] || emptyBucket(),
    month,
    total: data.total,
  };
}

async function usageReset() {
  await chrome.storage.local.remove(USAGE_KEY);
}

// ── Бекор қилиш ────────────────────────────────────────────────────────────
//
// runId - бир «таржима сеанси». Content script уни ҳар ишга туширишда
// янгилайди, бекор қилганда эса шу id бўйича учиб турган fetch'лар узилади.

const inflight = new Map(); // runId -> Set<AbortController>

function trackRequest(runId, controller) {
  if (runId == null) return;
  let set = inflight.get(runId);
  if (!set) {
    set = new Set();
    inflight.set(runId, set);
  }
  set.add(controller);
}

function untrackRequest(runId, controller) {
  const set = inflight.get(runId);
  if (!set) return;
  set.delete(controller);
  if (!set.size) inflight.delete(runId);
}

function abortRun(runId) {
  const set = inflight.get(runId);
  if (!set) return 0;
  const count = set.size;
  for (const controller of set) controller.abort();
  inflight.delete(runId);
  return count;
}

// ── Хабарлар ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'UZ_TRANSLATE_BATCH') {
    handleTranslateBatch(msg.segments, msg.runId, msg.force, msg.blockMode)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((err) => sendResponse({
        ok: false, error: describe(err), aborted: Boolean(err?.aborted),
      }));
    return true;
  }

  if (msg.type === 'UZ_SUMMARIZE') {
    handleSummarize(msg.text, msg.runId)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({
        ok: false, error: describe(err), aborted: Boolean(err?.aborted),
      }));
    return true;
  }

  if (msg.type === 'UZ_ABORT') {
    sendResponse({ ok: true, aborted: abortRun(msg.runId) });
    return false;
  }

  if (msg.type === 'UZ_CACHE_STATS') {
    cacheStats()
      .then((stats) => sendResponse({ ok: true, ...stats }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  if (msg.type === 'UZ_USAGE_STATS') {
    usageStats()
      .then((stats) => sendResponse({ ok: true, ...stats }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  if (msg.type === 'UZ_USAGE_RESET') {
    usageReset()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  if (msg.type === 'UZ_CACHE_LIST') {
    cacheList({ query: msg.query, limit: msg.limit })
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  if (msg.type === 'UZ_CACHE_DELETE') {
    cacheDelete(msg.keys)
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  if (msg.type === 'UZ_CACHE_CLEAR') {
    cacheClear()
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  if (msg.type === 'UZ_CHECK_KEY') {
    // Popup очилганда менюни ҳам янгилаб оламиз: фойдаланувчи
    // chrome://extensions/shortcuts да қисқартмани ўзгартирган бўлиши мумкин,
    // Chrome эса бунинг учун ҳеч қандай ҳодиса юбормайди.
    buildMenus().catch(() => { /* меню янгиланмаса ҳам иш давом этсин */ });

    getSettings()
      .then((s) => sendResponse({ ok: true, hasKey: Boolean(s.apiKey), model: s.model }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  return undefined;
});

function describe(err) {
  if (err instanceof OpenRouterError) return err.message;
  return err?.message ? String(err.message) : 'Номаълум хато.';
}

// ── Таржима ────────────────────────────────────────────────────────────────

/**
 * @param {string[]} segments
 * @param {number} runId - бекор қилиш учун
 * @param {boolean} force - кэшни четлаб ўтиб, моделдан қайта сўраш
 * @returns {{segments: string[], fromCache: number, fresh: number}}
 */
async function handleTranslateBatch(segments, runId, force = false, blockMode = false) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { segments: [], fromCache: 0, fresh: 0 };
  }

  const { apiKey, model, cacheEnabled } = await getSettings();
  // Блок режимида матн теглар билан келади, шунинг учун кэш калити ҳам
  // табиий равишда бошқача бўлади - алоҳида белги қўшиш шарт эмас.
  const system = blockMode ? blockSystemPrompt() : translateSystemPrompt();

  const keys = cacheEnabled
    ? await Promise.all(segments.map((text) => hashKey(model, text)))
    : null;

  // force бўлса ўқимаймиз, лекин янги натижани барибир ёзиб қўямиз
  const cached = (cacheEnabled && !force)
    ? await cacheRead(keys)
    : new Array(segments.length).fill(undefined);

  const result = new Array(segments.length);
  const pending = [];
  const pendingIndex = [];

  segments.forEach((text, i) => {
    if (cached[i] !== undefined) {
      result[i] = cached[i];
    } else {
      pending.push(text);
      pendingIndex.push(i);
    }
  });

  if (pending.length) {
    const controller = new AbortController();
    trackRequest(runId, controller);
    try {
      const { segments: translated, usage } = await translateSegments(pending, {
        apiKey, model, system, signal: controller.signal,
      });
      await recordUsage(usage);
      translated.forEach((value, k) => {
        result[pendingIndex[k]] = value;
      });
      if (cacheEnabled) {
        await cacheWrite(pendingIndex.map((i) => keys[i]), translated, pending);
      }
    } finally {
      untrackRequest(runId, controller);
    }
  }

  return {
    segments: result,
    fromCache: segments.length - pending.length,
    fresh: pending.length,
  };
}

// ── Хулоса ─────────────────────────────────────────────────────────────────
// Матн узун бўлса - бўлакларга бўлиб, кейин бирлаштирамиз.

const CHUNK_CHARS = 16000;
const SINGLE_PASS_LIMIT = 22000;

async function handleSummarize(text, runId) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Саҳифада хулоса қилишга матн топилмади.');

  const { apiKey, model, summaryStyle } = await getSettings();

  // Узун саҳифада бир нечта сўров кетма-кет кетади - ҳаммаси битта
  // controller остида, шунда бекор қилиш занжирни бирданига узади.
  const controller = new AbortController();
  trackRequest(runId, controller);
  const signal = controller.signal;

  try {
    if (clean.length <= SINGLE_PASS_LIMIT) {
      const single = await completeText({
        apiKey,
        model,
        system: summarySystemPrompt(summaryStyle),
        user: clean,
        maxTokens: 2048,
        signal,
      });
      await recordUsage(single.usage);
      return single.text;
    }

    const chunks = splitChunks(clean, CHUNK_CHARS);
    const partials = [];
    for (const chunk of chunks) {
      const partial = await completeText({
        apiKey,
        model,
        system: summarySystemPrompt('short'),
        user: chunk,
        maxTokens: 1024,
        signal,
      });
      await recordUsage(partial.usage);
      partials.push(partial.text);
    }

    const merged = await completeText({
      apiKey,
      model,
      system: reduceSystemPrompt(summaryStyle),
      user: partials.join('\n\n---\n\n'),
      maxTokens: 2048,
      signal,
    });
    await recordUsage(merged.usage);
    return merged.text;
  } finally {
    untrackRequest(runId, controller);
  }
}

// ── Контекст меню ва клавиатура қисқартмаси ────────────────────────────────
//
// Иккаласи ҳам popup'ни очмасдан ишлайди. activeTab рухсати айнан шу учта
// ҳаракатда берилади: иконка босилганда, контекст менюдан танланганда ва
// manifest'да эълон қилинган қисқартма босилганда.

// Пункт номига қисқартма қўшилади. Уни манифестдан эмас, `commands.getAll()`
// дан оламиз: фойдаланувчи chrome://extensions/shortcuts да ўзгартирган
// бўлса, менюда ҳам ўзгарган қиймат кўринсин.
//
// Танланган матн ва саҳифа пунктлари бир вақтда кўринмайди (матн устига ўнг
// тугма босилса Chrome фақат `selection` пунктларини чиқаради), шунинг учун
// битта қисқартмани иккала пунктга ҳам ёзиш чалкашлик туғдирмайди.
function menuItems(shortcuts) {
  const key = (command) => (shortcuts[command] ? `  (${shortcuts[command]})` : '');

  return [
    {
      id: 'uz-sel-llm',
      title: `Белгиланганни LLM билан ўгириш${key('translate-llm')}`,
      contexts: ['selection'],
    },
    {
      id: 'uz-sel-translit',
      title: `Белгиланганни транслитерация қилиш${key('translate-translit')}`,
      contexts: ['selection'],
    },
    {
      id: 'uz-page-llm',
      title: `Саҳифани LLM билан ўгириш${key('translate-llm')}`,
      contexts: ['page'],
    },
    {
      id: 'uz-page-translit',
      title: `Саҳифани транслитерация қилиш${key('translate-translit')}`,
      contexts: ['page'],
    },
    { id: 'uz-sep', type: 'separator', contexts: ['page', 'selection'] },
    {
      id: 'uz-revert',
      title: `Асл матнга қайтариш${key('revert')}`,
      contexts: ['page', 'selection'],
    },
  ];
}

async function buildMenus() {
  const shortcuts = {};
  try {
    for (const command of await chrome.commands.getAll()) {
      if (command.shortcut) shortcuts[command.name] = command.shortcut;
    }
  } catch { /* commands API бўлмаса - қисқартмасиз номлар */ }

  const items = menuItems(shortcuts);
  chrome.contextMenus.removeAll(() => {
    for (const item of items) {
      chrome.contextMenus.create({
        ...item,
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(buildMenus);

async function requireKey(tabId, mode) {
  if (mode !== 'llm') return true;
  const { apiKey } = await getSettings();
  if (apiKey) return true;
  await badge(tabId, 'API-калит киритилмаган. Созламаларни очинг.', {
    error: true, autoHideMs: 6000,
  });
  return false;
}

async function actOnTab(tabId, { mode, onlySelection = null, revert = false }) {
  const frameSet = await attach(tabId);

  if (revert) {
    await revertAll(tabId, frameSet);
    await badge(tabId, 'Асл матн қайтарилди', { autoHideMs: 2000 });
    return;
  }

  if (!await requireKey(tabId, mode)) return;

  // onlySelection берилмаса - матн белгиланган бўлса ўшани, акс ҳолда саҳифани
  const useSelection = onlySelection === null
    ? frameSet.selectionFrameId !== null
    : onlySelection && frameSet.selectionFrameId !== null;

  await runTranslate(tabId, frameSet, { mode, onlySelection: useSelection });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  const plan = {
    'uz-sel-llm': { mode: 'llm', onlySelection: true },
    'uz-sel-translit': { mode: 'translit', onlySelection: true },
    'uz-page-llm': { mode: 'llm', onlySelection: false },
    'uz-page-translit': { mode: 'translit', onlySelection: false },
    'uz-revert': { revert: true },
  }[info.menuItemId];

  if (!plan) return;
  actOnTab(tab.id, plan).catch((err) => console.warn('[uz] контекст меню:', err.message));
});

chrome.commands.onCommand.addListener(async (command) => {
  const plan = {
    'translate-llm': { mode: 'llm' },
    'translate-translit': { mode: 'translit' },
    revert: { revert: true },
  }[command];
  if (!plan) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await actOnTab(tab.id, plan);
  } catch (err) {
    console.warn('[uz] қисқартма:', err.message);
  }
});

function splitChunks(text, size) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      // Жумла ёки абзац чегарасидан кесишга ҳаракат қиламиз
      const window = text.slice(start, end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '));
      if (cut > size * 0.5) end = start + cut + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}
