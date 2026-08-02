// LLM учун промптлар. Модель фақат кирилл ўзбекчада жавоб бериши шарт.

const CYRILLIC_RULES = `
Output language: UZBEK written in the CYRILLIC alphabet only.

Hard rules:
- Every Uzbek word must consist entirely of Cyrillic letters. Never leave a Latin
  letter inside an Uzbek word (watch the lookalikes a/а o/о p/р c/с e/е k/к x/х y/у).
- Never use Russian words. Translate them into Uzbek
  (например -> масалан, все -> ҳаммаси, продолжение -> давом).
- Use the Uzbek-only letters where they belong: қ ғ ҳ ў ё.
- Keep unchanged: proper nouns, brand and product names, code identifiers,
  file paths, URLs, e-mail addresses, numbers, units and currency symbols.
`.trim();

export function translateSystemPrompt() {
  return `You are a professional translator working on web page content.

${CYRILLIC_RULES}

Task:
- You receive a JSON object: {"n": <count>, "t": ["segment 1", "segment 2", ...]}.
- Translate every segment into Cyrillic Uzbek.
- Segments come from the page DOM in reading order. Some are sentence fragments,
  headings, button labels or list items - keep them as fragments, do not merge,
  do not split, do not add punctuation that was not there.
- Keep leading/trailing spacing semantics: return the translated text only,
  without extra surrounding whitespace.
- If a segment is already correct Cyrillic Uzbek, return it unchanged.
- Do not add explanations, notes, or markdown.

Response format - STRICT JSON, nothing else:
{"t": ["...", "..."]}
The array must contain exactly n strings, in the same order as the input.`;
}

export function summarySystemPrompt(style) {
  const size = {
    short: 'Жуда қисқа: 3–4 та асосий нуқта, ҳар бири бир жумла.',
    medium: 'Ўрта: 5–7 та асосий нуқта, ҳар бири 1–2 жумла.',
    detailed: 'Батафсил: 8–12 та нуқта, зарур жойда кичик изоҳлар билан.',
  }[style] || 'Ўрта: 5–7 та асосий нуқта, ҳар бири 1–2 жумла.';

  return `You summarize web page content for a reader of Uzbek.

${CYRILLIC_RULES}

Task:
- You receive the readable text of a web page.
- Produce a summary in Cyrillic Uzbek.
- Size: ${size}
- Base the summary strictly on the given text. Do not invent facts, numbers or
  names that are not in it. If the text is truncated or incoherent, say so.

Output format (plain text, no markdown fences, no code blocks):
САРЛАВҲА: <бир қаторли сарлавҳа>

АСОСИЙ НУҚТАЛАР:
- <нуқта>
- <нуқта>

ХУЛОСА: <2–3 жумла>`;
}

export function reduceSystemPrompt(style) {
  return `${summarySystemPrompt(style)}

Note: the input you receive is a set of partial summaries of consecutive parts of
one page. Merge them into a single coherent summary, removing repetition.`;
}
