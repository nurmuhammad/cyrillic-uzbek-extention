// Саҳифа устидаги амалларни бошқариш. Popup ҳам, background ҳам (контекст
// меню ва клавиатура қисқартмаси учун) шу модулни ишлатади.
//
// Нима учун фреймлар билан овора бўламиз: кўп сайт (масалан t.me) асосий
// матнни iframe ичида кўрсатади. Фақат юқори фреймга юкланса, ўша матн
// таржима қилинмай қолади.

export const CONTENT_FILES = [
  'src/content/translit.js',
  'src/content/detect.js',
  'src/content/extract.js',
  'src/content/content.js',
];

export const TOP_FRAME = 0;

export function sendToFrame(tabId, frameId, message) {
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

/** Хатони ютиб юборадиган вариант - кўп фреймга сўров юборганда керак. */
export async function trySendToFrame(tabId, frameId, message) {
  try {
    return await sendToFrame(tabId, frameId, message);
  } catch {
    return null;
  }
}

export async function injectAll(tabId) {
  // Content script'да гуард байроғи бор, шунинг учун қайта инжекция зарарсиз
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

/**
 * Content script'ни юклаб, ҳар фреймдан маълумот йиғади.
 * @returns {{frames: object[], mainFrameId: number, selectionFrameId: number|null}}
 */
export async function attach(tabId) {
  const ids = await injectAll(tabId);

  const infos = await Promise.all(ids.map(async (frameId) => {
    const response = await trySendToFrame(tabId, frameId, { type: 'UZ_PING' });
    return response ? { frameId, ...response } : null;
  }));

  const frames = infos
    .filter(Boolean)
    .filter((f) => f.chars > 0 || f.frameId === TOP_FRAME);

  if (!frames.length) throw new Error('Саҳифага уланиб бўлмади.');

  // Асосий матн энг кўп бўлган фрейм - хулоса ва тил тахмини шундан олинади
  const mainFrameId = frames
    .reduce((best, f) => (f.chars > best.chars ? f : best), frames[0]).frameId;

  const withSelection = frames.find((f) => f.selection && f.selection.chars > 0);

  return {
    frames,
    mainFrameId,
    selectionFrameId: withSelection ? withSelection.frameId : null,
  };
}

/**
 * Таржимани ишга туширади.
 * @param {'llm'|'translit'} mode
 * @returns {{started: number, total: number}}
 */
export async function runTranslate(tabId, frameSet, { mode, force = false, onlySelection = false }) {
  const targets = onlySelection && frameSet.selectionFrameId !== null
    ? [frameSet.selectionFrameId]
    : frameSet.frames.map((f) => f.frameId);

  const results = await Promise.all(targets.map((frameId) => trySendToFrame(tabId, frameId, {
    type: 'UZ_RUN',
    mode,
    force,
    onlySelection,
  })));

  return { started: results.filter(Boolean).length, total: targets.length };
}

export async function revertAll(tabId, frameSet) {
  await Promise.all(frameSet.frames.map(
    (f) => trySendToFrame(tabId, f.frameId, { type: 'UZ_REVERT' }),
  ));
}

export async function cancelAll(tabId, frameSet) {
  await Promise.all(frameSet.frames.map(
    (f) => trySendToFrame(tabId, f.frameId, { type: 'UZ_CANCEL' }),
  ));
}

export async function collectSummaryText(tabId, frameSet, onlySelection) {
  const frameId = onlySelection && frameSet.selectionFrameId !== null
    ? frameSet.selectionFrameId
    : frameSet.mainFrameId;

  const response = await sendToFrame(tabId, frameId, {
    type: 'UZ_COLLECT_TEXT',
    onlySelection,
  });
  return (response.text || '').trim();
}

/** Хулоса панели ҳар доим юқори фреймда: iframe ичида у қисилиб қолади. */
export async function showSummary(tabId, text) {
  await trySendToFrame(tabId, TOP_FRAME, { type: 'UZ_SHOW_TEXT', text });
}

export async function badge(tabId, text, { error = false, autoHideMs = 0 } = {}) {
  await trySendToFrame(tabId, TOP_FRAME, {
    type: 'UZ_BADGE', text, error, autoHideMs,
  });
}
