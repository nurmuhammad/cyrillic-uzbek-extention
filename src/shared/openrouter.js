// OpenRouter клиенти. Фақат service worker (background.js) ичида ишлайди -
// content script'дан fetch қилинса, саҳифанинг CORS сиёсатига тушиб қолади.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ATTEMPTS = 3;

export class OpenRouterError extends Error {
  constructor(message, { status = 0, retryable = false, aborted = false } = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.retryable = retryable;
    // Фойдаланувчи бекор қилгани - хато эмас, шунинг учун алоҳида белги
    this.aborted = aborted;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Битта chat completion сўрови. Қайта уриниш 429 ва 5xx да ишлайди.
 * `json: true` бўлса response_format сўралади; модель уни қўллаб-қувватламаса,
 * автоматик равишда усиз қайта юборилади.
 */
function abortError() {
  return new OpenRouterError('Бекор қилинди.', { aborted: true });
}

async function chat({ apiKey, model, system, user, json = false, maxTokens = 4096, signal }) {
  if (!apiKey) {
    throw new OpenRouterError('API-калит киритилмаган. Созламаларни очинг.');
  }

  let allowJsonFormat = json;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError();

    const body = {
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (allowJsonFormat) body.response_format = { type: 'json_object' };

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // OpenRouter рейтинги учун ихтиёрий, лекин фойдали
          'X-Title': 'Uzbek Cyrillic Translator',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // AbortController ишлаганда fetch AbortError отади - уни қайта урунмаймиз
      if (err?.name === 'AbortError' || signal?.aborted) throw abortError();
      lastError = new OpenRouterError(
        `Тармоқ хатоси: ${err.message}`, { retryable: true },
      );
      await sleep(400 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        lastError = new OpenRouterError('Моделдан бўш жавоб келди.', { retryable: true });
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return { text, usage: normalizeUsage(data.usage) };
    }

    const raw = await res.text().catch(() => '');
    const message = extractApiError(raw) || raw.slice(0, 300) || res.statusText;

    // Модель response_format'ни қўлламаса - усиз қайта уринамиз
    if (res.status === 400 && allowJsonFormat && /response_format|json_object/i.test(message)) {
      allowJsonFormat = false;
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new OpenRouterError(`API-калит қабул қилинмади (${res.status}). ${message}`, {
        status: res.status,
      });
    }
    if (res.status === 402) {
      throw new OpenRouterError(`OpenRouter балансида маблағ етарли эмас. ${message}`, {
        status: res.status,
      });
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new OpenRouterError(`Сервер банд (${res.status}). ${message}`, {
        status: res.status,
        retryable: true,
      });
      await sleep(800 * 2 ** attempt);
      continue;
    }

    throw new OpenRouterError(`Сўров рад этилди (${res.status}). ${message}`, {
      status: res.status,
    });
  }

  throw lastError || new OpenRouterError('Номаълум хато.');
}

/**
 * OpenRouter жавобидаги usage. `cost` ҳамма моделда ҳам келавермайди -
 * келмаса 0 бўлиб қолади ва фақат токенлар ҳисобланади.
 */
function normalizeUsage(usage) {
  if (!usage) return { input: 0, output: 0, cost: 0 };
  return {
    input: Number(usage.prompt_tokens) || 0,
    output: Number(usage.completion_tokens) || 0,
    cost: Number(usage.cost) || 0,
  };
}

function extractApiError(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || null;
  } catch {
    return null;
  }
}

/** Модель JSON'ни фенса ичига ўраб юбориши мумкин - тозалаб парс қиламиз. */
export function parseJsonLoose(text) {
  let cleaned = text.trim();
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) cleaned = fence[1].trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new OpenRouterError('Модель жавобини JSON сифатида ўқиб бўлмади.');
  }
}

/**
 * Бир гуруҳ матн бўлагини таржима қилади.
 * Қайтади: шу тартибдаги, шу узунликдаги массив.
 */
export async function translateSegments(segments, { apiKey, model, system, signal }) {
  const { text: raw, usage } = await chat({
    apiKey,
    model,
    system,
    user: JSON.stringify({ n: segments.length, t: segments }),
    json: true,
    maxTokens: Math.min(8192, 512 + segments.join(' ').length * 2),
    signal,
  });

  const parsed = parseJsonLoose(raw);
  const out = Array.isArray(parsed) ? parsed : parsed?.t;

  if (!Array.isArray(out)) {
    throw new OpenRouterError('Модель кутилган "t" массивини қайтармади.');
  }
  if (out.length !== segments.length) {
    throw new OpenRouterError(
      `Бўлаклар сони мос келмади: ${segments.length} юборилди, ${out.length} қайтди.`,
    );
  }
  // Ҳар эҳтимолга қарши: бўш ёки нотўғри турдаги элементни аслига қайтарамиз
  const normalized = out.map((value, i) =>
    typeof value === 'string' && value.trim() ? value : segments[i],
  );
  return { segments: normalized, usage };
}

/** Эркин матн қайтарувчи сўров (хулоса учун). */
export async function completeText({ apiKey, model, system, user, maxTokens = 2048, signal }) {
  return chat({ apiKey, model, system, user, json: false, maxTokens, signal });
}
