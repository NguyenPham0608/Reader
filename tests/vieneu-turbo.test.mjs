// The plain-logic parts of the VieNeu Turbo voice: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTokenizer, readNpz, syllableCount, maxFrames, turboPieces } from '../vieneu-turbo-lib.js';

const json = JSON.parse(readFileSync(new URL('./fixtures/vieneu-turbo-tokenizer.json', import.meta.url), 'utf8'));
const encode = makeTokenizer(json);
const tokenOf = Object.fromEntries(Object.entries(json.model.vocab).map(([t, id]) => [id, t]));

// GPT-2's byte map, reversed: what the tokenizer's characters stand for.
const byteOf = (() => {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  for (let b = 0, n = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
  return new Map(cs.map((c, i) => [String.fromCharCode(c), bs[i]]));
})();
const decode = (ids) => new TextDecoder().decode(Uint8Array.from([...ids.map((id) => tokenOf[id]).join('')].map((ch) => byteOf.get(ch))));

// Phonemes as sea-g2p writes them (from its README and the vieneu package's tests).
const PHONEMES = [
  'zˈaːɜ ˈɛɜt̪ pˈe nˈam tʃˈam hˈom nˈaj lˌaː2 bˈoɜn ŋˈi2n hˈaːj tʃˈam fˈəɪ4 nˈam ɗˈiɛ4m.',
  'kˈə4n tˈə6n.',
  'sˈækaɪ, ɲˈə6t̪ bˈaː4n.',
  'nˌoʊɾɪfɪkˈeɪʃən.',
  'ŋˈɛ hˈaj kwˈaːɜ.',
];

test('phonemes become tokens that spell them exactly, none unknown, with merges made', () => {
  const unk = json.model.vocab[json.model.unk_token];
  for (const ph of PHONEMES) {
    const ids = encode(ph);
    assert.equal(decode(ids), ph.normalize('NFC'));
    assert.ok(!ids.includes(unk), ph);
    assert.ok(ids.length < new TextEncoder().encode(ph).length, `no merges in ${ph}`);
  }
});

test('the model\'s own tokens are kept whole', () => {
  assert.deepEqual(encode('tʃˈaː2w <|emotion_1|>').slice(-1), [json.model.vocab['<|emotion_1|>']]);
});

test('syllables are counted as the vieneu package counts them', () => {
  assert.equal(syllableCount('kwˈaːɜ'), 1);        // quá: the tone mark is not a vowel
  assert.equal(syllableCount('bˈaːɜw'), 1);
  assert.equal(syllableCount('kɹiːˈeɪt'), 2);      // create
  assert.equal(syllableCount('kəmpjˈuːɾɚ'), 3);    // computer
  assert.equal(syllableCount('ɹˈeɪdɪˌoʊ'), 3);     // radio
  assert.equal(syllableCount('ŋˈɛ hˈaj kwˈaːɜ.'), 3);
  assert.equal(syllableCount('<|emotion_1|>'), 0);
});

test('short pieces get a tight cap on their length, long ones one by their phonemes', () => {
  assert.equal(maxFrames('tʃˈaː2w.'), 13);               // one syllable: about a second
  assert.equal(maxFrames('ŋˈɛ hˈaj kwˈaːɜ.'), 23);       // three: 13 + 2 × 5
  const long = PHONEMES[0];
  assert.equal(maxFrames(long), Math.min(300, 24 + Math.ceil(2 * [...long].length)));
  assert.equal(maxFrames('a '.repeat(400)), 300);
});

test('a long sentence is cut where a reader would pause, and nothing is lost', () => {
  const s = 'Thuật toán quét qua quét lại dọc theo một thứ tự một chiều của các obitan, gọi là mạng, '
    + 'và trong mỗi bước của một lượt quét, mạng được chia thành bốn khối: hai khối lớn thay đổi kích thước trong suốt lượt quét '
    + 'và hai khối nhỏ giữ nguyên kích thước, đóng vai trò đệm giữa chúng.';
  const pieces = turboPieces(s);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((p) => p.length <= 240));
  assert.ok(pieces.slice(0, -1).every((p) => /[,;:]$/.test(p)), pieces.join(' | '));
  assert.equal(pieces.join(' '), s);
  assert.deepEqual(turboPieces('Kết quả'), ['Kết quả']);
});

/** A .npz as NumPy writes it with np.savez: stored entries, each a .npy. */
function npz(arrays) {
  const parts = [];
  for (const [name, { dtype, shape, values }] of Object.entries(arrays)) {
    const dict = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
    const pad = 64 - ((10 + dict.length + 1) % 64);
    const header = new TextEncoder().encode(dict + ' '.repeat(pad % 64) + '\n');
    const data = new Uint8Array((dtype === '<f4' ? Float32Array : Float64Array).from(values).buffer);
    const npy = new Uint8Array(10 + header.length + data.length);
    npy.set([0x93, ...new TextEncoder().encode('NUMPY'), 1, 0, header.length & 255, header.length >> 8]);
    npy.set(header, 10);
    npy.set(data, 10 + header.length);
    const fname = new TextEncoder().encode(`${name}.npy`);
    const local = new Uint8Array(30 + fname.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint32(18, npy.length, true);
    v.setUint32(22, npy.length, true);
    v.setUint16(26, fname.length, true);
    local.set(fname, 30);
    parts.push(local, npy);
  }
  const end = new Uint8Array(22);
  new DataView(end.buffer).setUint32(0, 0x06054b50, true);
  parts.push(end);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

test('a NumPy .npz is read, as floats, whatever their width', () => {
  const file = npz({
    text_emb: { dtype: '<f4', shape: [2, 3], values: [1, 2, 3, 4, 5, 6.5] },
    xvec_ln_eps: { dtype: '<f8', shape: [], values: [1e-5] },
  });
  const got = readNpz(file.subarray(0)); // as fetched: the bytes, perhaps a view
  assert.deepEqual(got.text_emb.shape, [2, 3]);
  assert.deepEqual([...got.text_emb.data], [1, 2, 3, 4, 5, 6.5]);
  assert.deepEqual(got.xvec_ln_eps.shape, []);
  assert.ok(Math.abs(got.xvec_ln_eps.data[0] - 1e-5) < 1e-12);
});

test('the code scores are added onto the acoustic model as one more input, output and three nodes', async () => {
  const { gemmModel, withHead, protoFields } = await import('../vieneu-turbo-lib.js');
  const base = gemmModel(3, 2, Float32Array.from([1, 2, 3, 4, 5, 6])); // stands in for the acoustic model
  const fused = withHead(base, 2, 3, 2, new Float32Array(12));
  const top = (m) => protoFields(m).map((f) => f.num);
  assert.deepEqual(top(fused).sort(), top(base).sort()); // IR version, opset and graph, nothing lost
  const graphOf = (m) => { const g = protoFields(m).find((f) => f.num === 7); return m.subarray(g.body, g.end); };
  const names = (g, num) => protoFields(g).filter((f) => f.num === num).map((f) => {
    const sub = g.subarray(f.body, f.end), name = protoFields(sub).find((x) => x.num === (num === 1 ? 4 : 1));
    return new TextDecoder().decode(sub.subarray(name.body, name.end));
  });
  const g = graphOf(fused);
  assert.deepEqual(names(g, 1), ['Gemm', 'Gather', 'Gather', 'Gemm']);
  assert.deepEqual(names(g, 11), ['x', 'codebook']);
  assert.deepEqual(names(g, 12), ['y', 'logits']);
  assert.equal(protoFields(g).filter((f) => f.num === 5).length, 3); // the base's weights, the index, the codebooks' weights
});

test('abbreviations are marked to be said in English, letter by letter or as the word', async () => {
  const { englishAbbreviations: f } = await import('../vieneu-turbo-lib.js');
  assert.equal(f('Thuật toán DMRG chạy trên GPU.'), 'Thuật toán <en>d m r g</en> chạy trên <en>g p u</en>.');
  assert.equal(f('Phân tử mRNA và cơ quan NASA.'), 'Phân tử <en>m r n a</en> và cơ quan <en>nasa</en>.');
  assert.equal(f('Phần II và IV.'), 'Phần II và IV.'); // numerals
  assert.equal(f('PHẦN HAI: KẾT QUẢ'), 'PHẦN HAI: KẾT QUẢ'); // a heading in capitals
  assert.equal(f('Một DVD và LCD.'), 'Một <en>d v d</en> và <en>l c d</en>.');
});
