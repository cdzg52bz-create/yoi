// 形態素（kuromoji のトークン）に方言の法則を当てて言い直す。
// Claude を使わないとき（お試しモード）の関西弁・博多弁で使う。

const I_ROW = 'イキシチニヒミリギジビピ';
const E_ROW = 'エケセテネヘメレゲゼデベペ';

const isEnd = (t) => !t || t.pos === '記号';
const isPart = (t, ...ws) => !!t && t.pos === '助詞' && ws.includes(t.surface_form);
const isFinalPart = (t, ...ws) => isPart(t, ...ws) && t.pos_detail_1 === '終助詞';
const isAux = (t, base) => !!t && t.pos === '助動詞' && t.basic_form === base;
const isVerb = (t) => !!t && t.pos === '動詞';
const isNaiAux = (t) => isAux(t, 'ない') && ['ない', 'なかっ', 'なく'].includes(t.surface_form);
// 「の」「ん」が説明の意味で使われているとき（行くんだ・行くのです）
const isNoN = (t) => !!t && t.pos === '名詞' && t.pos_detail_1 === '非自立' && (t.surface_form === 'の' || t.surface_form === 'ん');
const isMizenBeforeNai = (t, next) => isVerb(t) && t.conjugated_form.startsWith('未然') && isNaiAux(next);
// 「〜ている」の「いる」と、縮まった「〜てる」
const isTeIru = (t, prev) => isVerb(t) && t.pos_detail_1 === '非自立' && t.basic_form === 'いる' && isPart(prev, 'て', 'で');
const isTeru = (t) => isVerb(t) && t.pos_detail_1 === '非自立' && (t.basic_form === 'てる' || t.basic_form === 'でる');

// 「いる」型の活用を、頭の音だけ差し替えて作る（おる・とる・どる）
function iruLike(head, t, next) {
  const f = t.conjugated_form;
  if (f.startsWith('未然')) return head + 'ら';
  if (f.startsWith('連用')) {
    if (isAux(next, 'ます')) return head + 'り';
    return head + 'っ';
  }
  if (f.startsWith('仮定')) return head + 'れ';
  if (f.startsWith('命令')) return head + 'れ';
  return head + 'る';
}

const LEX = {
  kansai: {
    '本当に': 'ほんまに', 'ほんとうに': 'ほんまに', 'ほんとに': 'ほんまに',
    '本当': 'ほんま', 'ほんとう': 'ほんま', 'ほんと': 'ほんま',
    'だめ': 'あかん', 'ダメ': 'あかん', '駄目': 'あかん',
    'なぜ': 'なんで', 'どうして': 'なんで',
    '馬鹿': 'アホ', 'バカ': 'アホ', 'ばか': 'アホ',
    'いくら': 'なんぼ',
    '違う': 'ちゃう', '違い': 'ちゃい',
    'すごく': 'めっちゃ', 'とても': 'めっちゃ', 'めちゃくちゃ': 'めっちゃ', 'めちゃ': 'めっちゃ', '非常に': 'めっちゃ'
  },
  hakata: {
    '本当に': 'ほんなこつ', 'ほんとうに': 'ほんなこつ', 'ほんとに': 'ほんなこつ',
    'だめ': 'いかん', 'ダメ': 'いかん', '駄目': 'いかん',
    'なぜ': 'なんで', 'どうして': 'なんで',
    'すごく': 'ばり', 'とても': 'ばり', 'めちゃくちゃ': 'ばり', 'めちゃ': 'ばり', 'めっちゃ': 'ばり', '非常に': 'ばり'
  }
};

const CLEANUP = {
  kansai: [
    [/(じゃ|では)なかった/g, 'ちゃうかった'],
    [/(じゃ|では)ない/g, 'ちゃう'],
    [/じゃん/g, 'やん'],
    [/あかんや(?=[。！？!?、\s]|$)/g, 'あかん'],
    [/あかんや([でな])/g, 'あかん$1']
  ],
  hakata: [
    [/(じゃ|では)なかった/g, 'やなかった'],
    [/(じゃ|では)ない/g, 'やない'],
    [/じゃん/g, 'やん'],
    [/いかんや(?=[。！？!?、\s]|$)/g, 'いかん'],
    [/いかんやね/g, 'いかんね']
  ]
};

export const MORPH_DIALECTS = ['kansai', 'hakata'];

export function convertTokens(tokens, dialect) {
  const K = dialect === 'kansai';
  const lex = LEX[dialect];
  const out = [];
  const pushed = []; // out と同じ位置に、元のトークン
  const put = (s, t) => { out.push(s); pushed.push(t); };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], prev = tokens[i - 1], next = tokens[i + 1], next2 = tokens[i + 2];
    const s = t.surface_form;

    // ありがとう（ございます／ございました）
    if (K && t.basic_form === 'ありがとう') {
      let j = i;
      if (isAux(tokens[j + 1], 'ござる')) {
        j++;
        while (tokens[j + 1] && tokens[j + 1].pos === '助動詞') j++;
      }
      put('おおきに', t); i = j; continue;
    }

    // 決まった言い換え
    if (lex[s] && !(s === '違う' && !isVerb(t))) { put(lex[s], t); continue; }

    // 「いいじゃん」の「いい」は動詞「言う」と解析されることがある
    if (isVerb(t) && t.basic_form === 'いう' && s === 'いい' && next && /^じゃ/.test(next.surface_form)) {
      put(K ? 'ええ' : 'よか', t); continue;
    }

    // 形容詞
    if (t.pos === '形容詞') {
      const f = t.conjugated_form;
      if (['いい', '良い', 'よい'].includes(s) && f === '基本形') { put(K ? 'ええ' : 'よか', t); continue; }
      if (K && /^(面白|おもしろ)/.test(s)) { put(s.replace(/^(面白|おもしろ)/, 'おもろ'), t); continue; }
      if (!K && f === '基本形' && t.pos_detail_1 === '自立' && s.endsWith('い') && s !== 'ない'
        && (isEnd(next) || isFinalPart(next, 'ね', 'よ', 'な'))) {
        put(s === 'うるさい' ? 'せからしか' : s.slice(0, -1) + 'か', t); continue;
      }
      put(s, t); continue;
    }

    // 「〜ている」「〜てる」
    if (isTeIru(t, prev)) {
      if (K) { put(s.slice(1), t); continue; } // てる・てた・てへん
      out[out.length - 1] = prev.surface_form === 'て' ? 'と' : 'ど';
      put(iruLike('', t, next), t); continue; // とる・とった・とらん
    }
    if (isTeru(t)) {
      if (K) { put(s, t); continue; }
      if (t.conjugated_form.startsWith('連用') && !isAux(next, 'た') && !isAux(next, 'ます')) { put(s, t); continue; }
      put(iruLike(t.basic_form === 'てる' ? 'と' : 'ど', t, next), t); continue;
    }

    // 「いる」→「おる」
    if (isVerb(t) && t.pos_detail_1 === '自立' && t.basic_form === 'いる' && t.conjugated_type.startsWith('一段')) {
      put(iruLike('お', t, next), t); continue;
    }

    // 打ち消し（〜ない）の前の動詞
    if (isMizenBeforeNai(t, next)) {
      let stem = s;
      if (t.conjugated_type.startsWith('サ変')) stem = K ? 'せえ' : 'せ';
      else if (t.conjugated_type.startsWith('カ変')) stem = K ? 'けえ' : 'こ';
      else if (K && t.conjugated_type.startsWith('一段') && s.length === 1) {
        const v = t.reading.slice(-1);
        if (I_ROW.includes(v)) stem = s + 'い';
        else if (E_ROW.includes(v)) stem = s + 'え';
      }
      put(stem, t); continue;
    }
    // 打ち消しの「ない」
    if (isNaiAux(t) && isVerb(prev) && prev.conjugated_form.startsWith('未然')) {
      const lastStem = out[out.length - 1];
      const hi = K && /い$/.test(lastStem) && I_ROW.includes((prev.reading || '').slice(-1)) && prev.surface_form.length === 1;
      if (K) {
        const n = hi ? 'ひん' : 'へん';
        put(s === 'ない' ? n : s === 'なかっ' ? n + 'かっ' : n + 'く', t);
      } else if (s === 'なく' && isPart(next, 'て')) {
        put('んで', t); i++;
      } else {
        put(s === 'ない' ? 'ん' : s === 'なかっ' ? 'んかっ' : 'なく', t);
      }
      continue;
    }
    // 〜ません
    if (K && isAux(t, 'ます') && s === 'ませ' && next && next.surface_form === 'ん') {
      put('まへん', t); i++; continue;
    }

    // だ・です
    if (isAux(t, 'だ') || isAux(t, 'です')) {
      const f = t.conjugated_form;
      if (f.startsWith('連用') && isAux(next, 'た')) { put('やっ', t); continue; } // だった・でした
      if (f.startsWith('未然') && isAux(next, 'う')) { put('やろ', t); i++; continue; } // だろう・でしょう
      if (f !== '基本形') { put(s, t); continue; }
      if (isAux(t, 'です') && isPart(next, 'か')) { put('なん', t); i++; continue; } // ですか
      const yone = isFinalPart(next, 'よ') && isFinalPart(next2, 'ね');
      const yo = !yone && isFinalPart(next, 'よ');
      const ne = isFinalPart(next, 'ね', 'な');
      const atEnd = isEnd(next) || yone || yo || ne;
      if (atEnd && prev && prev.pos === '形容詞') {
        // 形容詞のあとの「です」は落とす（いいですね → ええな／よかね）
        if (K) put(yone ? 'よな' : yo ? 'で' : ne ? 'な' : '', t);
        else put(yone ? 'やろ' : yo ? 'ばい' : ne ? 'ね' : '', t);
      } else if (atEnd && isNoN(prev)) {
        // 行くんだ → 行くねん（関西）／行くと（博多）
        out[out.length - 1] = '';
        if (K) put(yone ? 'ねんな' : yo ? 'ねんで' : ne ? 'ねんな' : 'ねん', t);
        else put(yone ? 'とやろ' : yo ? 'とよ' : ne ? 'とね' : 'と', t);
      } else {
        if (K && prev && prev.surface_form === 'そう' && prev.pos === '副詞') out[out.length - 1] = 'せ';
        if (K) put(yone ? 'やんな' : yo ? 'やで' : ne ? 'やな' : 'や', t);
        else put(yone ? 'やろ' : yo ? 'ばい' : ne ? 'やね' : 'や', t);
      }
      if (yone) i += 2; else if (yo || ne) i++;
      continue;
    }

    // 終助詞
    if (t.pos === '助詞' && t.pos_detail_1 === '終助詞') {
      const afterMasu = isAux(prev, 'ます');
      if (s === 'よ' && isFinalPart(next, 'ね')) {
        put(K ? 'よな' : 'やろ', t); i++; continue;
      }
      if (s === 'よ' && !afterMasu) {
        put(isAux(prev, 'う') ? 'や' : K ? 'で' : 'ばい', t); continue;
      }
      if (s === 'ね' && K && !afterMasu) { put('な', t); continue; }
      if (s === 'の' && isEnd(next)) {
        const q = next && /[？?]/.test(next.surface_form);
        const afterN = /ん$/.test(out[out.length - 1] || '');
        put(K ? (q ? (afterN ? 'の' : 'ん') : 'ねん') : (q ? 'と' : 'とよ'), t); continue;
      }
      put(s, t); continue;
    }

    // 接続助詞（博多：から→けん、けど→ばってん）
    if (!K && t.pos === '助詞' && t.pos_detail_1 === '接続助詞') {
      if (s === 'から') { put('けん', t); continue; }
      if (['けど', 'けれど', 'けれども'].includes(s)) { put('ばってん', t); continue; }
    }

    put(s, t);
  }

  let text = out.join('');
  CLEANUP[dialect].forEach(([re, to]) => { text = text.replace(re, to); });
  return text;
}
