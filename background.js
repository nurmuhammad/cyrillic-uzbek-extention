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
  summarySystemPrompt,
  reduceSystemPrompt,
} from './src/shared/prompts.js';

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

async function cacheWrite(keys, values) {
  if (!keys.length) return;
  const now = Date.now();
  const patch = {};
  keys.forEach((key, i) => {
    patch[key] = { t: values[i], u: now };
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

async function cacheClear() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(STORE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ [COUNT_KEY]: 0 });
  memory.clear();
  return keys.length;
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
    handleTranslateBatch(msg.segments, msg.runId, msg.force)
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

  if (msg.type === 'UZ_CACHE_CLEAR') {
    cacheClear()
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true;
  }

  if (msg.type === 'UZ_CHECK_KEY') {
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
async function handleTranslateBatch(segments, runId, force = false) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { segments: [], fromCache: 0, fresh: 0 };
  }

  const { apiKey, model, cacheEnabled } = await getSettings();
  const system = translateSystemPrompt();

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
      const translated = await translateSegments(pending, {
        apiKey, model, system, signal: controller.signal,
      });
      translated.forEach((value, k) => {
        result[pendingIndex[k]] = value;
      });
      if (cacheEnabled) {
        await cacheWrite(pendingIndex.map((i) => keys[i]), translated);
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
      return await completeText({
        apiKey,
        model,
        system: summarySystemPrompt(summaryStyle),
        user: clean,
        maxTokens: 2048,
        signal,
      });
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
      partials.push(partial);
    }

    return await completeText({
      apiKey,
      model,
      system: reduceSystemPrompt(summaryStyle),
      user: partials.join('\n\n---\n\n'),
      maxTokens: 2048,
      signal,
    });
  } finally {
    untrackRequest(runId, controller);
  }
}

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
