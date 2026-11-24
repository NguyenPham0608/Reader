// Tests for speakable.js: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable } from '../speakable.js';

const vi = (text) => speakable(text, 'vi-VN');

test('Vietnamese whole numbers', () => {
  assert.equal(vi('0'), 'không');
  assert.equal(vi('5'), 'năm');
  assert.equal(vi('10'), 'mười');
  assert.equal(vi('11'), 'mười một');
  assert.equal(vi('15'), 'mười lăm');
  assert.equal(vi('20'), 'hai mươi');
  assert.equal(vi('21'), 'hai mươi mốt');
  assert.equal(vi('25'), 'hai mươi lăm');
  assert.equal(vi('64'), 'sáu mươi tư');
  assert.equal(vi('100'), 'một trăm');
  assert.equal(vi('105'), 'một trăm linh năm');
  assert.equal(vi('114'), 'một trăm mười bốn');
  assert.equal(vi('1000'), 'một nghìn');
  assert.equal(vi('1050'), 'một nghìn không trăm năm mươi');
  assert.equal(vi('1984'), 'một nghìn chín trăm tám mươi tư');
  assert.equal(vi('2004'), 'hai nghìn không trăm linh bốn');
  assert.equal(vi('1000500'), 'một triệu năm trăm');
  assert.equal(vi('3000000000'), 'ba tỷ');
});

test('Vietnamese separators: decimal comma, thousands dot', () => {
  assert.equal(vi('9,6'), 'chín phẩy sáu');
  assert.equal(vi('3,14'), 'ba phẩy mười bốn');
  assert.equal(vi('0,05'), 'không phẩy không năm');
  assert.equal(vi('64.000'), 'sáu mươi tư nghìn');
  assert.equal(vi('1.638.734'), 'một triệu sáu trăm ba mươi tám nghìn bảy trăm ba mươi tư');
  assert.equal(vi('2.5'), 'hai phẩy năm'); // a decimal point left from English
});

test('Vietnamese numbers in a sentence', () => {
  assert.equal(vi('Năm 2004, tăng 3% trên 64 bộ xử lý.'), 'Năm hai nghìn không trăm linh bốn, tăng ba phần trăm trên sáu mươi tư bộ xử lý.');
  assert.equal(vi('từ 2–5 giây'), 'từ hai đến năm giây');
  assert.equal(vi('đối xứng D 2h'), 'đối xứng D hai h');
  assert.equal(vi('H2O'), 'H hai O');
  assert.equal(vi('mã 007'), 'mã không không bảy');
});

test('identifiers are dropped in every language', () => {
  assert.equal(vi('Bản quyền, Viện Vật lý Hoa Kỳ. DOI: 10.1063/1.1638734.'), 'Bản quyền, Viện Vật lý Hoa Kỳ. DOI.');
  assert.equal(speakable('Voir https://example.org/a?b=1 pour plus.', 'fr-FR'), 'Voir pour plus.');
  assert.equal(speakable('Écrire à jean.dupont@example.fr, merci.', 'fr-FR'), 'Écrire à, merci.');
});

test('other languages keep their digits for their own voice', () => {
  assert.equal(speakable('En 2004, 64 processeurs.', 'fr-FR'), 'En 2004, 64 processeurs.');
});

test('text without numbers or identifiers is unchanged', () => {
  assert.equal(vi('Chúng tôi mô tả thuật toán DMRG.'), 'Chúng tôi mô tả thuật toán DMRG.');
});
