import { DEFAULTS, getSettings, setSettings } from '../shared/config.js';

const fields = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  scope: document.getElementById('scope'),
  batchChars: document.getElementById('batchChars'),
  concurrency: document.getElementById('concurrency'),
  summaryStyle: document.getElementById('summaryStyle'),
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
  } catch (err) {
    cacheStatsEl.textContent = err.message;
  }
});

getSettings().then(fill);
refreshCacheStats();
