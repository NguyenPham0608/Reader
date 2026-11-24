// The last touches to a translation before a voice says it. Claude is asked to write numbers out
// in words and to leave out identifiers nobody reads aloud; this catches what slips through. The
// Vietnamese voices need it most: Supertonic reads characters as they are, and says figures
// badly or not at all. System voices for other languages read figures well, so theirs are kept.

const IDENTIFIERS = [
  /\b(?:https?:\/\/|www\.)\S*[^\s.,;:!?)\]]/gi, // web addresses
  /\b10\.\d{4,9}\/\S*[^\s.,;:!?)\]]/g,          // DOIs
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,               // email addresses
];

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const SCALES = ['', 'nghìn', 'triệu', 'tỷ'];
const digitByDigit = (s) => [...s].map((d) => DIGITS[d]).join(' ');

/** 1–999 in Vietnamese. `full`: it follows a larger group, so empty hundreds and tens are said ("không trăm", "linh"). */
function hundreds(n, full) {
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, u = n % 10;
  const out = [];
  if (h || full) out.push(DIGITS[h], 'trăm');
  if (t === 0) { if (u && (h || full)) out.push('linh'); }
  else if (t === 1) out.push('mười');
  else out.push(DIGITS[t], 'mươi');
  // 21 is "hai mươi mốt", 25 "hai mươi lăm", 15 "mười lăm", 24 "hai mươi tư".
  if (u) out.push(u === 1 && t > 1 ? 'mốt' : u === 5 && t > 0 ? 'lăm' : u === 4 && t > 1 ? 'tư' : DIGITS[u]);
  return out.join(' ');
}

/** A string of digits as a Vietnamese number; one with a leading zero, or too long to say as a number, digit by digit. */
function integer(s) {
  if ((s.length > 1 && s[0] === '0') || s.length > 12) return digitByDigit(s);
  let n = Number(s);
  if (!n) return DIGITS[0];
  const groups = [];
  for (; n; n = Math.floor(n / 1000)) groups.unshift(n % 1000);
  const out = [];
  groups.forEach((g, i) => { if (g) out.push(hundreds(g, out.length > 0), SCALES[groups.length - 1 - i]); });
  return out.filter(Boolean).join(' ');
}

/** The digits after a decimal separator: leading zeros one by one, then a short rest as a number ("ba phẩy mười bốn"). */
function fraction(s) {
  const zeros = s.match(/^0*/)[0].length, rest = s.slice(zeros);
  const said = rest && (rest.length <= 2 ? integer(rest) : digitByDigit(rest));
  return [...Array(zeros).fill(DIGITS[0]), said].filter(Boolean).join(' ');
}

const decimal = (whole, frac) => (frac ? `${integer(whole)} phẩy ${fraction(frac)}` : integer(whole));

/** A number as written in a Vietnamese text: a comma before decimals, dots between thousands. */
function numberVi(token) {
  let m;
  if ((m = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/.exec(token))) return decimal(m[1].replace(/\./g, ''), m[2]);
  if ((m = /^(\d{1,3}(?:,\d{3}){2,})(?:\.(\d+))?$/.exec(token))) return decimal(m[1].replace(/,/g, ''), m[2]); // 1,000,000 left in English style
  if ((m = /^(\d+)[.,](\d+)$/.exec(token))) return decimal(m[1], m[2]);
  if (/^\d+$/.test(token)) return integer(token);
  return token.split(/([.,])/).map((part) => (part === '.' ? 'chấm' : part === ',' ? 'phẩy' : integer(part))).join(' ');
}

function spellNumbersVi(text) {
  return text
    .replace(/(\d)\s*[–—]\s*(?=\d)/g, '$1 đến ') // 2–5
    .replace(/\d+(?:[.,]\d+)*(\s*%)?/g, (match, pct, at, all) => {
      const words = numberVi(match.replace(/\s*%$/, '')) + (pct ? ' phần trăm' : '');
      // Figures run into letters ("H2O", "2h") are words of their own once spelled out.
      const before = /\p{L}/u.test(all[at - 1] || '') ? ' ' : '', after = /\p{L}/u.test(all[at + match.length] || '') ? ' ' : '';
      return before + words + after;
    });
}

/** `text` as the voice for `lang` (a tag such as 'vi-VN') should be given it. */
export function speakable(text, lang) {
  let out = text, dropped = false;
  for (const re of IDENTIFIERS) out = out.replace(re, () => { dropped = true; return ' '; });
  if (dropped) out = out.replace(/\s+([,.;:!?])/g, '$1').replace(/[,;:]+(?=[.,;:!?]|\s*$)/g, ''); // "DOI: ." → "DOI."
  if (lang.split('-')[0].toLowerCase() === 'vi') out = spellNumbersVi(out);
  return out === text ? text : out.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}
