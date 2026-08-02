// Саҳифа тилини/ёзувини тахминий аниқлаш. Натижа фақат маслаҳат учун -
// қайси тугмани босишни фойдаланувчининг ўзи ҳал қилади.

(() => {
  const UZ_LATIN_WORDS = new Set([
    'va', 'bilan', 'uchun', 'ham', 'bu', 'shu', 'ular', 'biz', 'siz', 'men',
    'sen', 'bor', 'emas', 'lekin', 'ammo', 'yoki', 'agar', 'kerak', 'mumkin',
    'hamda', 'haqida', 'orqali', 'keyin', 'oldin', 'qilish', 'edi', 'deb',
    'esa', 'faqat', 'barcha', 'har', 'juda', 'yana', 'endi', 'qanday',
    'qachon', 'kim', 'nima', 'nechta', 'yangi', 'katta', 'kichik', 'yaxshi',
    'boshqa', 'birinchi', 'ikkinchi', 'kabi', 'butun', 'olib', 'qilib',
    'bergan', 'kelgan', 'ketgan', 'davlat', 'yil', 'kun', 'oy', 'inson',
    'odam', 'ish', 'hozir', 'sabab', 'natija', 'misol',
  ]);

  // Лотин ўзбекчага хос ёзувлар: o' g' ва кўп учрайдиган қўшимчалар
  const UZ_LATIN_MARKS = /(?:o['‘’ʻʼ`]|g['‘’ʻʼ`]|\b\w+(?:lar|ning|dan|ga|da|ni|lik|chi)\b)/gi;

  // Ўзбек кириллига хос, рус алифбосида йўқ ҳарфлар
  const UZ_CYR_ONLY = /[ўқғҳЎҚҒҲ]/g;

  // Туркча/озарбайжонча ҳарфлар - лотин ўзбекча эмаслигига далил
  const NON_UZ_LATIN = /[ıİşŞğĞçÇöÖüÜñÑáéíóúàèìòùâêîôûäëïÿ]/g;

  const RU_WORDS = new Set([
    'и', 'в', 'не', 'на', 'что', 'с', 'по', 'это', 'как', 'но', 'для',
    'все', 'его', 'она', 'они', 'был', 'была', 'было', 'если', 'или',
    'при', 'так', 'уже', 'чтобы', 'который', 'также', 'может',
  ]);

  function countMatches(text, re) {
    const found = text.match(re);
    return found ? found.length : 0;
  }

  /**
   * @param {string} sample - саҳифанинг асосий матнидан намуна
   * @returns {{script: 'uz-latn'|'uz-cyrl'|'other', label: string, hint: 'translit'|'llm'|'none'}}
   */
  function detect(sample) {
    const text = String(sample || '').slice(0, 8000);
    if (text.trim().length < 40) {
      return { script: 'other', label: 'Матн жуда кам', hint: 'llm' };
    }

    const latin = countMatches(text, /[A-Za-z]/g);
    const cyr = countMatches(text, /[Ѐ-ӿ]/g);
    const letters = latin + cyr;
    if (letters < 30) {
      return { script: 'other', label: 'Тил аниқланмади', hint: 'llm' };
    }

    const words = text.toLowerCase().match(/[\p{L}'‘’ʻʼ]+/gu) || [];

    if (cyr > latin) {
      const uzOnly = countMatches(text, UZ_CYR_ONLY);
      const ruHits = words.filter((w) => RU_WORDS.has(w)).length;
      const uzCyrScore = uzOnly / Math.max(1, cyr);
      if (uzCyrScore > 0.01 && uzOnly > ruHits) {
        return {
          script: 'uz-cyrl',
          label: 'Кирилл ўзбекча - таржима шарт эмас',
          hint: 'none',
        };
      }
      return { script: 'other', label: 'Кирилл (эҳтимол русча)', hint: 'llm' };
    }

    const foreign = countMatches(text, NON_UZ_LATIN);
    if (foreign / Math.max(1, latin) > 0.01) {
      return { script: 'other', label: 'Лотин - ўзбекча эмас', hint: 'llm' };
    }

    const stopHits = words.filter((w) => UZ_LATIN_WORDS.has(w)).length;
    const markHits = countMatches(text, UZ_LATIN_MARKS);
    const score = (stopHits * 2 + markHits) / Math.max(10, words.length);

    if (score >= 0.08) {
      return {
        script: 'uz-latn',
        label: 'Лотин ўзбекча - LLM’сиз ўгириш мумкин',
        hint: 'translit',
      };
    }

    return { script: 'other', label: 'Лотин - бошқа тил', hint: 'llm' };
  }

  self.UZ_DETECT = { detect };
})();
