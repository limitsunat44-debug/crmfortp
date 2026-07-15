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
const sandboxSrc = [
  'mergeDailyReportQuestions',
  'isDailyAnswerComplete',
  'dailyReportProgress',
].map((n) => extractFunction(HTML, n)).join('\n\n');
vm.runInContext(sandboxSrc + '\n;', context);
const merge = context.mergeDailyReportQuestions;
const isComplete = context.isDailyAnswerComplete;
const progress = context.dailyReportProgress;

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

console.log('\nisDailyAnswerComplete:');

test('пустой / пробелы / null → неполный', () => {
  ['', '   ', '\n\t', null, undefined].forEach(v =>
    assert.strictEqual(isComplete(v), false, JSON.stringify(v)));
});

test('только пунктуация → неполный', () => {
  ['-', '—', '.', '...', '???', '!!', '--'].forEach(v =>
    assert.strictEqual(isComplete(v), false, v));
});

test('типовые отписки → неполный', () => {
  ['нет', 'Нет', 'НЕТ', 'не знаю', 'не знаю.', 'хз', 'ничего', 'ок', 'норм',
   'n/a', 'none', 'без комментариев', 'нету', 'все ок'].forEach(v =>
    assert.strictEqual(isComplete(v), false, v));
});

test('слишком короткий ответ → неполный', () => {
  ['да', 'ок!', '5', '2 врача'].forEach(v =>
    assert.strictEqual(isComplete(v), false, v));
});

test('одно длинное слово (мало слов) → неполный', () => {
  assert.strictEqual(isComplete('проанализировал'), false);
});

test('содержательный ответ → полный', () => {
  [
    'Обзвонил пять врачей, двое согласились на встречу',
    'Нашёл 3 новых врача: кардиолог, невролог, терапевт',
    'Проверил продажи, расхождений нет по всем точкам',
  ].forEach(v => assert.strictEqual(isComplete(v), true, v));
});

test('«нет расхождений» — содержательный ответ (не отписка)', () => {
  assert.strictEqual(isComplete('Расхождений не обнаружено, всё сходится'), true);
});

console.log('\ndailyReportProgress:');

const pq = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

test('пустые ответы → 0%', () => {
  const r = progress(pq, {});
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.complete, 0);
  assert.strictEqual(r.percent, 0);
});

test('считает только содержательные ответы', () => {
  const answers = {
    '1': 'Обзвонил врачей и договорился о поставке',  // complete
    '2': 'нет',                                        // placeholder → нет
    '3': '-',                                          // пунктуация → нет
    '4': 'Нашёл двух новых кардиологов сегодня',       // complete
  };
  const r = progress(pq, answers);
  assert.strictEqual(r.complete, 2);
  assert.strictEqual(r.percent, 50);
});

test('все содержательные → 100%', () => {
  const answers = {
    '1': 'Первый развёрнутый ответ по работе',
    '2': 'Второй развёрнутый ответ по звонкам',
    '3': 'Третий развёрнутый ответ по врачам',
    '4': 'Четвёртый развёрнутый ответ по планам',
  };
  assert.strictEqual(progress(pq, answers).percent, 100);
});

test('процент округляется (1 из 3 → 33%)', () => {
  const r = progress([{ id: 1 }, { id: 2 }, { id: 3 }],
    { '1': 'Развёрнутый содержательный ответ здесь' });
  assert.strictEqual(r.percent, 33);
});

test('нет вопросов → 0% без деления на ноль', () => {
  const r = progress([], {});
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.percent, 0);
});

console.log(`\nИтого: ${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
