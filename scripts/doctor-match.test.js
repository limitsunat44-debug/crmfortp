'use strict';

// Pure-function tests for doctor autocomplete matching used by both the
// Visit and Plan modals in index.html. We extract normalizeDoctorName and
// matchDoctors directly from index.html (the single source of truth) and
// exercise them, so the test fails if the shared matching logic regresses.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(source, name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'could not find function ' + name + ' in index.html');
  // Walk braces from the first { after the signature to find the body end.
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return source.slice(start, i);
}

const normalizeSrc = extractFunction(html, 'normalizeDoctorName');
const matchSrc = extractFunction(html, 'matchDoctors');

// Evaluate the extracted functions in an isolated scope.
// eslint-disable-next-line no-eval
const factory = new Function(
  normalizeSrc + '\n' + matchSrc + '\nreturn { normalizeDoctorName, matchDoctors };'
);
const { normalizeDoctorName, matchDoctors } = factory();

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

const directory = [
  { code: '1001', name: 'Курбонов Алишер Рустамович' },
  { code: '1002', name: 'Каримова Зухра' },
  { code: '1003', name: 'Каримов Бахтиёр' },
  { code: '2050', name: 'Ёкубов Фарход' },
];

// --- normalizeDoctorName ---
check('normalize lowercases + ё→е', normalizeDoctorName('Ёкубов') === 'екубов');
check('normalize collapses punctuation/space', normalizeDoctorName('  Каримова,  Зухра ') === 'каримова зухра');
check('normalize null safe', normalizeDoctorName(null) === '');

// --- matchDoctors: code mode ---
let r = matchDoctors(directory, '1001', 'code');
check('exact code match returns exact', r.exact && r.exact.code === '1001');
check('exact code match name', r.exact.name === 'Курбонов Алишер Рустамович');

r = matchDoctors(directory, '100', 'code');
check('partial code returns multiple', r.matches.length === 3);
check('partial code has no exact', r.exact === null);

r = matchDoctors(directory, '', 'code');
check('empty code → no matches', r.matches.length === 0 && r.exact === null);

r = matchDoctors(directory, '9999', 'code');
check('unknown code → no matches', r.matches.length === 0 && r.exact === null);

// --- matchDoctors: name mode ---
r = matchDoctors(directory, 'Курбонов', 'name');
check('surname match finds doctor', r.matches.length === 1 && r.matches[0].code === '1001');

r = matchDoctors(directory, 'карим', 'name');
check('partial surname finds both Karimov(a)', r.matches.length === 2);

r = matchDoctors(directory, 'ёкубов', 'name');
check('ё/е normalization in name search', r.matches.length === 1 && r.matches[0].code === '2050');

r = matchDoctors(directory, 'Каримова Зухра', 'name');
check('full FIO matches exact doctor', r.matches.some(d => d.code === '1002'));

r = matchDoctors(directory, 'Курб', 'name');
check('soft fallback: prefix surname matches', r.matches.some(d => d.code === '1001'));

r = matchDoctors(directory, '   ', 'name');
check('whitespace-only name → no matches', r.matches.length === 0);

console.log('doctor-match.test.js: ' + passed + ' assertions passed');
