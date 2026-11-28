// Tests for textlayout.js: node --test tests/*.test.mjs
// The cases come from real PDFs (journal articles, a textbook, a novel's scan, a how-to guide).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLines, guessGroups, buildBlock, sentenceRanges, keepHyphen, mathish, regions } from '../textlayout.js';

const sentences = (text) => sentenceRanges(text).map(([s, e]) => text.slice(s, e).trim());

// A PDF text item: `y` is the baseline, measured down the page; widths are a rough half em a letter.
const item = (str, x, y, { size = 10, font = 'F1', width = str.length * size * 0.5 } = {}) =>
  ({ str, transform: [size, 0, 0, size, x, y], width, fontName: font });
const VT = [1, 0, 0, 1, 0, 0];
/** Lines of text set one under another: [text, options] or text. */
const page = (rows, { x = 60, y = 100, lead = 12, size = 10 } = {}) => rows.map((row, i) => {
  const [str, opt = {}] = Array.isArray(row) ? row : [row];
  return item(str, opt.x ?? x, opt.y ?? y + i * (opt.lead ?? lead), { size, ...opt });
});
const paragraphs = (items) => guessGroups(extractLines(items, VT)).flatMap((g) => regions(g)).map((ls) => buildBlock(ls)?.text).filter(Boolean);

// ── Sentences ───────────────────────────────────────────────────────────────

test('sentences end where they end', () => {
  assert.deepEqual(sentences('The results are shown in Table 1. The errors are small.'), ['The results are shown in Table 1.', 'The errors are small.']);
  assert.deepEqual(sentences('It was found by Smith et al. We agree.'), ['It was found by Smith et al.', 'We agree.']);
  assert.deepEqual(sentences('It is shown.12 The rest follows.'), ['It is shown.12', 'The rest follows.']);
  assert.deepEqual(sentences('Force constants (e.g., harmonic).1,2 However, it is hard.'), ['Force constants (e.g., harmonic).1,2', 'However, it is hard.']);
  assert.deepEqual(sentences('Coefficients C and energies E. Each matrix is blocked.'), ['Coefficients C and energies E.', 'Each matrix is blocked.']);
});

test('a raised citation number after a full stop ends the sentence', () => {
  const text = 'carried out in MOLPRO 2015.1.29 For simplicity, sets are shortened.';
  const at = text.indexOf('29');
  assert.deepEqual(sentenceRanges(text, [[at, at + 2]]).map(([s, e]) => text.slice(s, e).trim()),
    ['carried out in MOLPRO 2015.1.29', 'For simplicity, sets are shortened.']);
  // The PDF's raised run can take the space after it along.
  assert.deepEqual(sentenceRanges(text, [[at, at + 3]]).map(([s, e]) => text.slice(s, e).trim()),
    ['carried out in MOLPRO 2015.1.29', 'For simplicity, sets are shortened.']);
  // Not raised, it is a version number, and the sentence goes on.
  assert.deepEqual(sentences(text), [text]);
});

test('and not at the full stops of abbreviations, citations and labels', () => {
  assert.deepEqual(sentences('See Fig. 2 for details.'), ['See Fig. 2 for details.']);
  assert.deepEqual(sentences('It costs approx. five dollars.'), ['It costs approx. five dollars.']);
  assert.deepEqual(sentences('Spin-adapted algorithms J. Chem. Phys. 136, 124121 (2012).'), ['Spin-adapted algorithms J. Chem. Phys. 136, 124121 (2012).']);
  assert.deepEqual(sentences('Cite This: J. Phys. Chem. Lett. 2021, 12, 3232.'), ['Cite This: J. Phys. Chem. Lett. 2021, 12, 3232.']);
  assert.deepEqual(sentences('Chapter 1. Introduction to Vectors'), ['Chapter 1. Introduction to Vectors']);
  assert.deepEqual(sentences('Figure 3. The density of states.'), ['Figure 3. The density of states.']);
});

// ── Words ───────────────────────────────────────────────────────────────────

test('a hyphen at a line end is kept where it belongs', () => {
  assert.equal(keepHyphen('two', 'electron'), true);
  assert.equal(keepHyphen('M', 'series'), true);
  assert.equal(keepHyphen('cc', 'pVnZ'), true);
  assert.equal(keepHyphen('pro', 'posed'), false);
  assert.equal(keepHyphen('al', 'gorithm'), false);
  assert.equal(keepHyphen('hyperpolariz', 'abilities'), false);
  // The rest of the page settles it either way.
  assert.equal(keepHyphen('co', 'workers', new Set(['co-workers'])), true);
  assert.equal(keepHyphen('self', 'ish', new Set(['selfish'])), false);
});

test('words come out whole across lines', () => {
  const [text] = paragraphs(page([
    'The method was pro-', 'posed for two-', 'electron integrals of the VnZ-', 'F12 sets and aV5Z/', 'JKFit in one go.',
  ]));
  assert.equal(text, 'The method was proposed for two-electron integrals of the VnZ-F12 sets and aV5Z/JKFit in one go.');
});

test("a font's own dash glyph reads as a dash, and loose accents join their letter", () => {
  const items = [
    item('correction scheme', 60, 100, { width: 72 }), item('', 132, 100, { width: 10 }),
    item('the CABS singles correction', 142, 100, { width: 114 }), item('', 256, 100, { width: 10 }),
    item('was proposed.', 266, 100, { width: 50 }),
    item('the electronic Schro', 60, 112, { width: 80 }), item('¨dinger equation.', 140, 112, { width: 70 }),
  ];
  assert.deepEqual(paragraphs(items), ['correction scheme—the CABS singles correction—was proposed. the electronic Schrödinger equation.']);
});

// ── Paragraphs ──────────────────────────────────────────────────────────────

test('a drop cap starts its word and keeps its paragraph together', () => {
  const items = [
    item('D ', 60, 112, { size: 24, width: 22 }), item('erivatives of electronic energy expressions are essential', 84, 100, { width: 216 }),
    ...page(['for routine computations in quantum chemistry (e.g.,'], { x: 84, y: 112 }),
    ...page(['equilibrium geometries and force constants. As such, new', 'variations of these theories are limited in use.'], { y: 124 }),
  ];
  const texts = paragraphs(items);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^Derivatives of electronic energy expressions are essential for routine computations/);
});

test('a bold start belongs to its paragraph; a short heading does not', () => {
  const lead = paragraphs(page([
    ['Main actor by default. New Xcode projects set the isolation to MainActor so that', { font: 'Bold' }],
    'all your code runs on the main thread unless you say otherwise.',
  ]));
  assert.equal(lead.length, 1);
  const heading = paragraphs(page([
    ['Three columns', { font: 'Bold' }],
    'Statement, reason and reference: the reference lists the earlier lines a step uses.',
  ]));
  assert.equal(heading.length, 2);
});

test('a list item starts a new paragraph', () => {
  const texts = paragraphs(page([
    'The steps are short and quick to do:',
    '• Install Xcode from the Mac App Store.',
    '• Open it once so it can install its components.',
  ]));
  assert.equal(texts.length, 3);
});

test('a short last line and a little more space end a paragraph that has no indent', () => {
  const items = [
    ...page(['Audio processing is the exception, and the tutorial shows', 'how to step off the main thread on purpose.'], { lead: 18 }),
    ...page(['App Sandbox. New Mac apps run in a sandbox, and to use the', 'microphone you tick a box under Signing.'], { y: 157, lead: 18 }),
  ];
  items[1].width = 120; // the paragraph's short last line
  assert.equal(paragraphs(items).length, 2);
});

test('a line whose type size came out wrong stays in its paragraph', () => {
  const items = page([
    'He said Dr Nemur I know Charlie is not what you had in mind as the',
    'first of your new brede of intelek but most people of his low',
    'mentel age are hostil and uncooperative and they are usualy dull',
    ['and hard to reach. He has a good natcher hes intristed and eager', { size: 6.4, width: 400 }],
    'to please.',
  ], { lead: 14.2 });
  for (const it of items.slice(0, 3)) it.width = 400;
  assert.equal(paragraphs(items).length, 1);
});

test("a displayed equation's scattered pieces are one block, with its number", () => {
  // Equation 4 of a journal article, as its PDF stores it: operators, terms, subscripts, number.
  const at = (str, x0, x1, y, size = 10) => item(str, x0, y, { size, width: x1 - x0 });
  const items = [
    at('where the matrix can be found through iterative solution of', 60, 300, 100),
    at('+', 91, 98, 126), at('−', 135, 142, 126), at('−', 179, 186, 126), at('=', 239, 246, 126),
    at('F', 72, 78, 126), at('F X', 101, 122, 126), at('X F', 145, 167, 126), at('X F X', 190, 226, 126), at('0', 249, 254, 126),
    at('VO', 78, 88, 128.5, 7), at('VV VO', 107, 132, 128.5, 7), at('VO OO', 152, 176, 128.5, 7), at('VO OV VO', 196, 236, 128.5, 7),
    at('(4)', 289, 300, 127, 9),
    at('Most implementations neglect the quadratic term in eq 4.', 60, 300, 144),
  ];
  const texts = paragraphs(items);
  assert.equal(texts.length, 3);
  assert.match(texts[1], /^\+ − − = F F X X F X F X 0 VO VV VO VO OO VO OV VO \(4\)$/);
});

test('formula pieces are told from words', () => {
  for (const t of ['λ λ μ μ', 'Tr{', 'ij ij', 'OV VO', '(4)', 'ϵ − ϵ =', 'CABS', '0']) assert.equal(mathish(t), true, t);
  for (const t of ['Article', 'INTRODUCTION', 'let name = "Tuner"', 'where p, q denote orbitals.']) assert.equal(mathish(t), false, t);
});
