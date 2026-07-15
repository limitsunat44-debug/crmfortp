'use strict';
/*
 * Юнит-тесты логики вкладки «Ежедневный отчёт ТП».
 *
 * Тестируемая функция mergeDailyReportQuestions ЖИВЁТ в index.html. Чтобы не
 * дублировать её, извлекаем исходник по имени (balanced-brace slicing) и
 * исполняем в изолированном контексте Node (vm) — тесты проверяют реально
 * задеплоенный код.
 *
 * Запуск:  node scripts/daily-report.test.js
 * Код возврата 0 — все тесты прошли; 1 — есть падения.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(src, name) {
  const sigRe = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = sigRe.exec(src);
  if (!m) throw new Error(`Не найдена функция ${name} в index.html`);
  let i = src.indexOf('{', m.index);
  assert.ok(i !== -1, `Нет тела у функции ${name}`);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  throw new Error(`Не закрыто тело функции ${name}`);
}

const context = {};
vm.createContext(context);
vm.runInContext(extractFunction(HTML, 'mergeDailyReportQuestions') + '\n;', context);
const merge = context.mergeDailyReportQuestions;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n      ${e && e.message}`);
  }
}

console.log('mergeDailyReportQuestions:');

const globals = [
  { id: 1, question_text: 'A', subquestions: ['a1'], is_active: true, sort_order: 10, applies_to: 'all' },
  { id: 2, question_text: 'B', subquestions: [], is_active: true, sort_order: 20, applies_to: 'all' },
  { id: 3, question_text: 'C', subquestions: [], is_active: true, sort_order: 30, applies_to: 'all' },
];

test('только глобальные вопросы, без overrides — порядок по sort_order', () => {
  const out = merge(globals, [], 'ivan');
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out.map(q => q.id).join(','), '1,2,3');
  assert.strictEqual(out[0].source, 'global');
});

test('неактивный вопрос отбрасывается', () => {
  const qs = globals.concat([{ id: 9, question_text: 'X', is_active: false, sort_order: 5, applies_to: 'all' }]);
  const out = merge(qs, [], 'ivan');
  assert.ok(!out.find(q => q.id === 9), 'is_active=false не должен попадать');
});

test('персональный вопрос ТП добавляется, чужой персональный — нет', () => {
  const qs = globals.concat([
    { id: 10, question_text: 'MyCustom', is_active: true, sort_order: 25, applies_to: 'ivan' },
    { id: 11, question_text: 'OtherCustom', is_active: true, sort_order: 26, applies_to: 'petr' },
  ]);
  const out = merge(qs, [], 'ivan');
  assert.ok(out.find(q => q.id === 10), 'персональный вопрос ivan есть');
  assert.ok(!out.find(q => q.id === 11), 'персональный вопрос petr отсутствует');
  const own = out.find(q => q.id === 10);
  assert.strictEqual(own.source, 'custom');
  // sort_order 25 → между B(20) и C(30)
  assert.strictEqual(out.map(q => q.id).join(','), '1,2,10,3');
});

test('override is_hidden скрывает глобальный вопрос для ТП', () => {
  const overrides = [{ question_id: 2, rep_login: 'ivan', is_hidden: true, custom_sort_order: null }];
  const out = merge(globals, overrides, 'ivan');
  assert.strictEqual(out.map(q => q.id).join(','), '1,3');
});

test('override custom_sort_order переупорядочивает вопрос для ТП', () => {
  const overrides = [{ question_id: 3, rep_login: 'ivan', is_hidden: false, custom_sort_order: 5 }];
  const out = merge(globals, overrides, 'ivan');
  // C получает порядок 5 → идёт первым
  assert.strictEqual(out.map(q => q.id).join(','), '3,1,2');
});

test('override не влияет на другого ТП (в merge передаются только его overrides)', () => {
  // Для petr overrides пустые → порядок обычный
  const out = merge(globals, [], 'petr');
  assert.strictEqual(out.map(q => q.id).join(','), '1,2,3');
});

test('custom_sort_order=0 уважается (не путается с отсутствием)', () => {
  const overrides = [{ question_id: 3, rep_login: 'ivan', is_hidden: false, custom_sort_order: 0 }];
  const out = merge(globals, overrides, 'ivan');
  assert.strictEqual(out[0].id, 3, 'custom_sort_order 0 поднимает C наверх');
});

test('subquestions по умолчанию массив, даже если поле кривое', () => {
  const qs = [{ id: 1, question_text: 'A', subquestions: null, is_active: true, sort_order: 10, applies_to: 'all' }];
  const out = merge(qs, [], 'ivan');
  assert.ok(Array.isArray(out[0].subquestions));
  assert.strictEqual(out[0].subquestions.length, 0);
});

test('пустой/нулевой вход → пустой массив', () => {
  assert.strictEqual(merge(null, null, 'ivan').length, 0);
  assert.strictEqual(merge([], [], 'ivan').length, 0);
});

test('стабильная сортировка при равном порядке — по id', () => {
  const qs = [
    { id: 5, question_text: 'E', is_active: true, sort_order: 0, applies_to: 'all' },
    { id: 2, question_text: 'B', is_active: true, sort_order: 0, applies_to: 'all' },
    { id: 8, question_text: 'H', is_active: true, sort_order: 0, applies_to: 'all' },
  ];
  const out = merge(qs, [], 'ivan');
  assert.strictEqual(out.map(q => q.id).join(','), '2,5,8');
});

console.log(`\nИтого: ${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
