import { DEFAULTS, getSettings, setSettings } from '../shared/config.js';

const fields = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  scope: document.getElementById('scope'),
  batchChars: document.getElementById('batchChars'),
  concurrency: document.getElementById('concurrency'),
  summaryStyle: document.getElementById('summaryStyle'),
  autoDynamic: document.getElementById('autoDynamic'),
  cacheEnabled: document.getElementById('cacheEnabled'),
  showBadge: document.getElementById('showBadge'),
};

const statusEl = document.getElementById('status');
const cacheStatsEl = document.getElementById('cache-stats');

function fill(settings) {
  fields.apiKey.value = settings.apiKey;
  fields.model.value = settings.model;
  fields.scope.value = settings.scope;
  fields.batchChars.value = settings.batchChars;
  fields.concurrency.value = settings.concurrency;
  fields.summaryStyle.value = settings.summaryStyle;
  fields.autoDynamic.checked = settings.autoDynamic;
  fields.cacheEnabled.checked = settings.cacheEnabled;
  fields.showBadge.checked = settings.showBadge;
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function collect() {
  return {
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim() || DEFAULTS.model,
    scope: fields.scope.value === 'page' ? 'page' : 'main',
    batchChars: clamp(fields.batchChars.value, 300, 6000, DEFAULTS.batchChars),
    concurrency: clamp(fields.concurrency.value, 1, 10, DEFAULTS.concurrency),
    summaryStyle: fields.summaryStyle.value,
    autoDynamic: fields.autoDynamic.checked,
    cacheEnabled: fields.cacheEnabled.checked,
    showBadge: fields.showBadge.checked,
  };
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function formatCost(cost) {
  if (!cost) return '-';
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

async function refreshUsage() {
  const body = document.getElementById('usage-body');
  try {
    const stats = await chrome.runtime.sendMessage({ type: 'UZ_USAGE_STATS' });
    if (!stats?.ok) throw new Error(stats?.error || 'Ҳисобни ўқиб бўлмади.');

    const rows = [
      ['Бугун', stats.today],
      ['Шу ой', stats.month],
      ['Жами', stats.total],
    ];

    body.textContent = '';
    for (const [label, bucket] of rows) {
      const tr = document.createElement('tr');
      for (const value of [
        label,
        String(bucket.requests || 0),
        formatTokens(bucket.input),
        formatTokens(bucket.output),
        formatCost(bucket.cost),
      ]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  } catch (err) {
    body.textContent = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = err.message;
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

async function refreshCacheStats() {
  try {
    const stats = await chrome.runtime.sendMessage({ type: 'UZ_CACHE_STATS' });
    if (!stats?.ok) throw new Error(stats?.error || 'Кэш ҳолатини ўқиб бўлмади.');
    const size = formatBytes(stats.bytes);
    cacheStatsEl.textContent = stats.count
      ? `${stats.count} та ёзув${size ? `, ${size}` : ''}`
      : 'Кэш бўш';
  } catch (err) {
    cacheStatsEl.textContent = err.message;
  }
}

function flash(text) {
  statusEl.textContent = text;
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

document.getElementById('save').addEventListener('click', async () => {
  const next = collect();
  await setSettings(next);
  fill(next);
  flash('Сақланди');
});

document.getElementById('reset').addEventListener('click', async () => {
  // Калитни ўчирмаймиз - уни фойдаланувчи ўзи тозалайди
  const keep = fields.apiKey.value.trim();
  const next = { ...DEFAULTS, apiKey: keep };
  await setSettings(next);
  fill(next);
  flash('Стандарт ҳолатга қайтарилди');
});

document.getElementById('toggle-key').addEventListener('click', (event) => {
  const shown = fields.apiKey.type === 'text';
  fields.apiKey.type = shown ? 'password' : 'text';
  event.target.textContent = shown ? 'Кўрсатиш' : 'Яшириш';
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  cacheStatsEl.textContent = 'Тозаланмоқда…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'UZ_CACHE_CLEAR' });
    if (!result?.ok) throw new Error(result?.error || 'Тозалаб бўлмади.');
    cacheStatsEl.textContent = `${result.removed} та ёзув ўчирилди`;
    if (!cacheBrowser.hidden) await refreshCacheList();
  } catch (err) {
    cacheStatsEl.textContent = err.message;
  }
});

// ── Кэш рўйхати ────────────────────────────────────────────────────────────

const cacheBrowser = document.getElementById('cache-browser');
const cacheListEl = document.getElementById('cache-list');
const cacheCountEl = document.getElementById('cache-count');
const cacheSearchEl = document.getElementById('cache-search');

let cacheSearchTimer = null;

function cacheRow(entry) {
  const row = document.createElement('div');
  row.className = 'cache-row';

  const texts = document.createElement('div');
  texts.className = 'texts';

  if (entry.s) {
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = entry.s;
    texts.appendChild(src);
  }

  const dst = document.createElement('div');
  dst.className = 'dst';
  dst.textContent = entry.t;
  texts.appendChild(dst);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = 'Бу ёзувни ўчириш';
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'UZ_CACHE_DELETE',
        keys: [entry.key],
      });
      if (!result?.ok) throw new Error(result?.error || 'Ўчириб бўлмади.');
      row.remove();
      await refreshCacheStats();
    } catch (err) {
      remove.disabled = false;
      cacheCountEl.textContent = err.message;
    }
  });

  row.appendChild(texts);
  row.appendChild(remove);
  return row;
}

async function refreshCacheList() {
  cacheListEl.textContent = '';
  cacheCountEl.textContent = 'Юкланмоқда…';

  try {
    const data = await chrome.runtime.sendMessage({
      type: 'UZ_CACHE_LIST',
      query: cacheSearchEl.value,
      limit: 200,
    });
    if (!data?.ok) throw new Error(data?.error || 'Рўйхатни ўқиб бўлмади.');

    if (!data.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'cache-empty';
      empty.textContent = cacheSearchEl.value.trim()
        ? 'Бу сўров бўйича ҳеч нарса топилмади.'
        : 'Кэш бўш.';
      cacheListEl.appendChild(empty);
      cacheCountEl.textContent = '';
      return;
    }

    for (const entry of data.entries) cacheListEl.appendChild(cacheRow(entry));
    cacheCountEl.textContent = data.matched > data.entries.length
      ? `${data.matched} тадан биринчи ${data.entries.length} таси кўрсатилди`
      : `${data.matched} та ёзув`;
  } catch (err) {
    cacheCountEl.textContent = err.message;
  }
}

document.getElementById('toggle-cache').addEventListener('click', async (event) => {
  const opening = cacheBrowser.hidden;
  cacheBrowser.hidden = !opening;
  event.target.textContent = opening ? 'Рўйхатни ёпиш' : 'Кэшни кўриш';
  if (opening) await refreshCacheList();
});

cacheSearchEl.addEventListener('input', () => {
  clearTimeout(cacheSearchTimer);
  cacheSearchTimer = setTimeout(refreshCacheList, 250);
});

document.getElementById('reset-usage').addEventListener('click', async () => {
  const statusEl2 = document.getElementById('usage-status');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'UZ_USAGE_RESET' });
    if (!result?.ok) throw new Error(result?.error || 'Тозалаб бўлмади.');
    statusEl2.textContent = 'Ҳисоб нолланди';
    setTimeout(() => { statusEl2.textContent = ''; }, 2000);
    await refreshUsage();
  } catch (err) {
    statusEl2.textContent = err.message;
  }
});

getSettings().then(fill);
refreshCacheStats();
refreshUsage();
