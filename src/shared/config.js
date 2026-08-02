// Созламалар.
//
// API-калит фақат шу браузерда, chrome.storage.local ичида сақланади.
// `sync` эмас - калит бошқа қурилмаларга кўчирилмайди ва ҳеч қандай
// серверга юборилмайди. Ягона чиқадиган жойи - openrouter.ai сўрови.

export const DEFAULTS = {
  apiKey: '',
  model: 'google/gemini-2.5-flash',

  // 'main' - фақат асосий ўқиладиган матн, 'page' - бутун саҳифа
  scope: 'main',

  // Бир сўровга кетадиган белгилар сони
  batchChars: 1500,
  // Параллел сўровлар сони
  concurrency: 4,

  // Таржима кэши. Ёқилган бўлса, аввал таржима қилинган матн қайта
  // сўралмайди - саҳифани иккинчи марта очганда моделга пул тўланмайди.
  cacheEnabled: true,

  // Хулоса ҳажми: 'short' | 'medium' | 'detailed'
  summaryStyle: 'medium',

  // Абзацни ичидаги ҳаволалари билан бирга, бир бутун ҳолда таржима қилиш.
  // Ўзбекчада феъл жумла охирига кетади, шунинг учун ҳаволалар билан
  // бўлинган жумлани бўлак-бўлак ўгирса сўз тартиби бузилади.
  blockMode: true,

  // Саҳифа кейин янги матн юкласа (чексиз лента, «яна юклаш»), уни ҳам
  // автоматик таржима қилиш
  autoDynamic: true,

  // Саҳифада прогресс кўрсаткичи
  showBadge: true,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}
