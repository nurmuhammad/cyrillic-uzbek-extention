// Лотин ўзбекча -> кирилл ўзбекча транслитерация. LLM талаб қилмайди,
// тармоққа чиқмайди, бир зумда ишлайди.
//
// Content script'лар умумий global scope'ни бўлишади, шунинг учун натижа
// `self.UZ_TRANSLIT` орқали бошқа файлларга кўринади.

(() => {
  const APOSTROPHES = "'‘’ʼʻ`´";

  // Кўп ҳарфли қоидалар - узунлиги бўйича камайиш тартибида текширилади
  const MULTI = [];
  for (const mark of APOSTROPHES) {
    MULTI.push([`o${mark}`, 'ў'], [`g${mark}`, 'ғ']);
  }
  MULTI.push(
    ['sh', 'ш'],
    ['ch', 'ч'],
    ['yo', 'ё'],
    ['yu', 'ю'],
    ['ya', 'я'],
    ['ye', 'е'],
  );
  MULTI.sort((a, b) => b[0].length - a[0].length);

  // Сўз бошида фарқ қиладиган қоидалар
  const WORD_START = [
    ['ye', 'е'],
    ['yo', 'ё'],
    ['yu', 'ю'],
    ['ya', 'я'],
    ['e', 'э'],
  ];

  const SINGLE = {
    a: 'а', b: 'б', c: 'с', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ',
    i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
    q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'х',
    y: 'й', z: 'з',
  };

  const LATIN_LETTER = /[A-Za-z]/;
  const URL_RE = /^(?:https?:\/\/|www\.)[^\s<>"']+/i;
  const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  const HANDLE_RE = /^[@#][\w.-]+/;

  function isWordStart(text, index) {
    if (index === 0) return true;
    const prev = text[index - 1];
    return !LATIN_LETTER.test(prev) && !APOSTROPHES.includes(prev);
  }

  function applyCase(source, target) {
    const first = source[0];
    if (first !== first.toUpperCase() || first === first.toLowerCase()) {
      return target; // манба кичик ҳарф
    }
    const rest = source.slice(1);
    const allCaps = rest.length === 0
      || rest.replace(new RegExp(`[${APOSTROPHES}]`, 'g'), '')
        .split('')
        .every((ch) => ch === ch.toUpperCase());
    return allCaps ? target.toUpperCase() : target[0].toUpperCase() + target.slice(1);
  }

  function toCyrillic(text) {
    if (!text) return text;

    let out = '';
    let i = 0;

    while (i < text.length) {
      const ch = text[i];

      // URL, e-mail, @ва # белгили номларни тегмасдан ўтказамиз
      if (isWordStart(text, i)) {
        const rest = text.slice(i);
        const skip = URL_RE.exec(rest) || EMAIL_RE.exec(rest) || HANDLE_RE.exec(rest);
        if (skip) {
          out += skip[0];
          i += skip[0].length;
          continue;
        }
      }

      if (!LATIN_LETTER.test(ch)) {
        // Ёлғиз турган тутуқ белгиси -> ъ (санъат, маъно)
        if (APOSTROPHES.includes(ch) && i > 0 && LATIN_LETTER.test(text[i - 1] || '')) {
          out += 'ъ';
          i += 1;
          continue;
        }
        out += ch;
        i += 1;
        continue;
      }

      const lower = text.slice(i, i + 2).toLowerCase();
      let matched = false;

      if (isWordStart(text, i)) {
        for (const [src, dst] of WORD_START) {
          if (lower.startsWith(src)) {
            out += applyCase(text.slice(i, i + src.length), dst);
            i += src.length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
      }

      for (const [src, dst] of MULTI) {
        if (text.slice(i, i + src.length).toLowerCase() === src) {
          out += applyCase(text.slice(i, i + src.length), dst);
          i += src.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      const single = SINGLE[ch.toLowerCase()];
      if (single) {
        out += applyCase(ch, single);
      } else {
        out += ch;
      }
      i += 1;
    }

    return out;
  }

  self.UZ_TRANSLIT = { toCyrillic };
})();
