'use strict';
/*
 * Юнит-тесты логики вкладки «Продажи» (сверка 1С/DocSales).
 *
 * Функции, которые тестируем, ЖИВУТ в index.html (клиентский код). Чтобы не
 * дублировать их, мы ИЗВЛЕКАЕМ исходники прямо из index.html по имени функции
 * (balanced-brace slicing) и исполняем в изолированном контексте Node (vm).
 * Так тесты всегда проверяют реально задеплоенный код, а не копию.
 *
 * Запуск:  node scripts/sales-recon.test.js
 * Код возврата 0 — все тесты прошли; 1 — есть падения.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Извлекает тело объявления `function <name>(...) { ... }` из исходника,
// корректно балансируя фигурные скобки (учитывает вложенность).
function extractFunction(src, name) {
  const sigRe = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = sigRe.exec(src);
  if (!m) throw new Error(`Не найдена функция ${name} в index.html`);
  // Находим открывающую { после списка аргументов.
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

// Собираем песочницу из нужных чистых функций и их зависимостей.
const NEEDED = [
  'normalizeDoctorName',
  'levenshteinDistance',
  'buildDoctorCodeResolver',
  'filterCacheRowsByRange',
  'buildReconList',
  'buildReconExportAoa',
];

const sandboxSrc = NEEDED.map((n) => extractFunction(HTML, n)).join('\n\n');
const context = {};
vm.createContext(context);
vm.runInContext(sandboxSrc + '\n;', context);

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

// ---------------------------------------------------------------------------
// filterCacheRowsByRange — строгое уважение выбранных дат
// ---------------------------------------------------------------------------
console.log('filterCacheRowsByRange:');

test('day-строки в диапазоне проходят, вне — отбрасываются', () => {
  const rows = [
    { doctor_code: '510', sale_date: '2026-06-01', amount: 970 },
    { doctor_code: '510', sale_date: '2026-06-02', amount: 1670 },
    { doctor_code: '510', sale_date: '2026-06-03', amount: 785 },
  ];
  const out = context.filterCacheRowsByRange(rows, '2026-06-01', '2026-06-02');
  assert.strictEqual(out.length, 2);
  const sum = out.reduce((s, r) => s + r.amount, 0);
  assert.strictEqual(sum, 970 + 1670, 'должны суммироваться только 2 выбранных дня');
});

test('полномесячная legacy-строка НЕ подтягивается при выборе пары дней', () => {
  const rows = [
    { doctor_code: '510', sale_date: null, period_start: '2026-05-01', period_end: '2026-05-31', amount: 10266 },
  ];
  const out = context.filterCacheRowsByRange(rows, '2026-06-01', '2026-06-02');
  assert.strictEqual(out.length, 0, 'строка за май не попадает в июньский выбор');
});

test('3-дневный агрегат НЕ попадает в 2-дневный выбор (period_end вне)', () => {
  const rows = [
    { doctor_code: '510', sale_date: null, period_start: '2026-06-01', period_end: '2026-06-03', amount: 3425 },
  ];
  const out = context.filterCacheRowsByRange(rows, '2026-06-01', '2026-06-02');
  assert.strictEqual(out.length, 0);
});

test('при наличии day-строк legacy-строка того же врача игнорируется (нет двойного счёта)', () => {
  const rows = [
    { doctor_code: '510', sale_date: '2026-06-01', amount: 970 },
    { doctor_code: '510', sale_date: '2026-06-02', amount: 1670 },
    { doctor_code: '510', sale_date: '2026-06-03', amount: 785 },
    { doctor_code: '510', sale_date: null, period_start: '2026-06-01', period_end: '2026-06-03', amount: 3425 },
  ];
  const out = context.filterCacheRowsByRange(rows, '2026-06-01', '2026-06-03');
  // 3 day-строки, агрегат отброшен.
  assert.strictEqual(out.length, 3);
  assert.ok(out.every((r) => r.sale_date), 'остаются только day-строки');
});

test('legacy-строка показывается, когда у врача нет day-строк и период целиком внутри', () => {
  const rows = [
    { doctor_code: '777', sale_date: null, period_start: '2026-06-01', period_end: '2026-06-03', amount: 500 },
  ];
  const out = context.filterCacheRowsByRange(rows, '2026-06-01', '2026-06-03');
  assert.strictEqual(out.length, 1);
});

test('строка с пустыми period-границами не падает и отбрасывается', () => {
  const rows = [{ doctor_code: 'x', sale_date: null, period_start: null, period_end: null, amount: 1 }];
  const out = context.filterCacheRowsByRange(rows, '2026-06-01', '2026-06-02');
  assert.strictEqual(out.length, 0);
});

test('пустой вход → пустой выход', () => {
  assert.strictEqual(context.filterCacheRowsByRange(null, '2026-06-01', '2026-06-02').length, 0);
});

// ---------------------------------------------------------------------------
// buildReconList — агрегация + канонизация врачей
// ---------------------------------------------------------------------------
console.log('buildReconList:');

test('1С и DocSales одного врача сливаются по точному имени (разные коды)', () => {
  const doctors = [{ doctor_code: '510', doctor_name: 'Курбонова Райфа' }];
  const onec = [{ doctor_code: '510', amount: 2640, checks_count: 3 }];
  // DocSales закэширован под другим числовым кодом, но имя совпадает точно.
  const docsales = [{ doctor_code: '673', doctor_name: 'Курбонова Райфа', amount: 2600, checks_count: 3, sale_date: '2026-06-01' }];
  const list = context.buildReconList(onec, docsales, doctors);
  assert.strictEqual(list.length, 1, 'точный матч по имени склеивает 510 и 673');
  assert.strictEqual(list[0].doctor_code, '510');
  assert.strictEqual(list[0].onec_amount, 2640);
  assert.strictEqual(list[0].docsales_amount, 2600);
});

test('фуззи-матч (1 правка) склеивает врача с опечаткой в имени', () => {
  const doctors = [{ doctor_code: '200', doctor_name: 'Иванова Мария' }];
  const onec = [{ doctor_code: '200', amount: 1000, checks_count: 1 }];
  // Опечатка в одной букве (расстояние Левенштейна 1) — в пределах порога.
  const docsales = [{ doctor_code: 'name:иванова марйя', doctor_name: 'Иванова Марйя', amount: 1000, sale_date: '2026-06-01' }];
  const list = context.buildReconList(onec, docsales, doctors);
  assert.strictEqual(list.length, 1, 'фуззи-матч склеивает по близкому имени');
  assert.strictEqual(list[0].doctor_code, '200');
});

test('разные врачи (расстояние > порога) НЕ склеиваются', () => {
  const doctors = [{ doctor_code: '300', doctor_name: 'Петров Иван' }];
  const onec = [{ doctor_code: '300', amount: 500, checks_count: 1 }];
  const docsales = [{ doctor_code: '999', doctor_name: 'Сидоров Олег', amount: 700, sale_date: '2026-06-01' }];
  const list = context.buildReconList(onec, docsales, doctors);
  assert.strictEqual(list.length, 2, 'непохожие имена остаются раздельными');
});

test('дедуп DocSales по коду×день берёт самую свежую synced_at', () => {
  const doctors = [{ doctor_code: '510', doctor_name: 'Иванов' }];
  const onec = [];
  const docsales = [
    { doctor_code: '673', doctor_name: 'Иванов', amount: 100, sale_date: '2026-06-01', synced_at: '2026-06-01T00:00:00Z' },
    { doctor_code: '510', doctor_name: 'Иванов', amount: 150, sale_date: '2026-06-01', synced_at: '2026-06-02T00:00:00Z' },
  ];
  const list = context.buildReconList(onec, docsales, doctors);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].docsales_amount, 150, 'берётся свежая строка, не сумма 250');
});

test('бонусы и статус считаются корректно', () => {
  const doctors = [{ doctor_code: '100', doctor_name: 'Тест' }];
  const onec = [{ doctor_code: '100', amount: 1000, checks_count: 5 }];
  const docsales = [{ doctor_code: '100', doctor_name: 'Тест', amount: 1000, sale_date: '2026-06-01' }];
  const list = context.buildReconList(onec, docsales, doctors);
  assert.strictEqual(list[0].bonus_10, 100);
  assert.strictEqual(list[0].bonus_patients, 50);
  assert.strictEqual(list[0].total_payable, 150);
  assert.strictEqual(list[0].status, 'matched');
});

test('расхождение > 10% помечается как mismatch', () => {
  const doctors = [{ doctor_code: '100', doctor_name: 'Тест' }];
  const onec = [{ doctor_code: '100', amount: 1000, checks_count: 0 }];
  const docsales = [{ doctor_code: '100', doctor_name: 'Тест', amount: 500, sale_date: '2026-06-01' }];
  const list = context.buildReconList(onec, docsales, doctors);
  assert.strictEqual(list[0].status, 'mismatch');
});

// ---------------------------------------------------------------------------
// buildReconExportAoa — форма данных для Excel
// ---------------------------------------------------------------------------
console.log('buildReconExportAoa:');

test('заголовок + строки, проценты как доля для формата 0.00%', () => {
  const state = {
    rows: [
      { doctor_code: '100', doctor_name: 'Тест', onec_amount: 1000, onec_checks: 5,
        docsales_amount: 900, docsales_checks: 5, diff_percent: 10, bonus_10: 100,
        bonus_patients: 50, total_payable: 150, status: 'matched' },
    ],
  };
  const { header, aoa, rowCount } = context.buildReconExportAoa(state);
  assert.strictEqual(header.length, 11);
  assert.strictEqual(rowCount, 1);
  assert.strictEqual(aoa.length, 2);
  const row = aoa[1];
  assert.strictEqual(row[0], '100');
  assert.strictEqual(row[2], 1000);
  assert.strictEqual(row[6], 0.10, 'процент делится на 100 для формата 0.00%');
  assert.strictEqual(row[10], 'сверено');
});

test('пустой diff_percent остаётся null (пустая ячейка)', () => {
  const state = { rows: [{ doctor_code: 'x', doctor_name: 'y', diff_percent: null, status: 'no_data' }] };
  const { aoa } = context.buildReconExportAoa(state);
  assert.strictEqual(aoa[1][6], null);
});

test('пустой стейт → только заголовок', () => {
  const { aoa, rowCount } = context.buildReconExportAoa({ rows: [] });
  assert.strictEqual(rowCount, 0);
  assert.strictEqual(aoa.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
