'use strict';
/*
 * Юнит-тесты логики контроля устройств («вход только с одобренных устройств»)
 * и аннулирования сессий.
 *
 * Тестируемые функции ЖИВУТ в index.html. Чтобы не дублировать их, извлекаем
 * исходник по имени (balanced-brace slicing) и исполняем в изолированном
 * контексте Node (vm) — тесты проверяют реально задеплоенный код.
 *
 * Запуск:  node scripts/device-approval.test.js
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
  'deviceAccessDecision',
  'isSessionStale',
  'isTableMissingError',
  'normalizeDeviceId',
  'shortDeviceId',
  'summarizeUserAgent',
].map((n) => extractFunction(HTML, n)).join('\n\n');
vm.runInContext(sandboxSrc + '\n;', context);

const decide = context.deviceAccessDecision;
const isStale = context.isSessionStale;
const isMissing = context.isTableMissingError;
const normalizeId = context.normalizeDeviceId;
const shortId = context.shortDeviceId;
const uaSummary = context.summarizeUserAgent;

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

console.log('deviceAccessDecision:');

test('одобренное устройство → вход разрешён, заявка не нужна', () => {
  const d = decide({ id: 1, status: 'approved' }, { isAdmin: false, tablesMissing: false });
  assert.strictEqual(d.allow, true);
  assert.strictEqual(d.status, 'approved');
  assert.strictEqual(d.reason, 'ok');
  assert.strictEqual(d.needsRequest, false);
});

test('неизвестное устройство → отказ + создаётся заявка', () => {
  const d = decide(null, { isAdmin: false, tablesMissing: false });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.status, 'none');
  assert.strictEqual(d.reason, 'device_unknown');
  assert.strictEqual(d.needsRequest, true);
  assert.ok(/не одобрено/.test(d.message), 'в сообщении есть причина отказа');
});

test('неизвестное устройство админа тоже НЕ пускает (роль не обходит проверку)', () => {
  const d = decide(null, { isAdmin: true, tablesMissing: false });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.needsRequest, true);
});

test('заявка в ожидании → отказ, метаданные заявки обновляются', () => {
  const d = decide({ id: 7, status: 'pending' }, { isAdmin: false, tablesMissing: false });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, 'device_pending');
  assert.strictEqual(d.needsRequest, true);
});

test('отклонённое устройство → отказ и НЕ возвращается в pending', () => {
  const d = decide({ id: 8, status: 'rejected' }, { isAdmin: false, tablesMissing: false });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, 'device_rejected');
  assert.strictEqual(d.needsRequest, false, 'иначе отклонение обходится повторным входом');
});

test('отклонённое устройство админа тоже не пускает', () => {
  const d = decide({ id: 9, status: 'rejected' }, { isAdmin: true, tablesMissing: false });
  assert.strictEqual(d.allow, false);
});

test('неизвестный статус трактуется как «нет одобрения»', () => {
  const d = decide({ id: 10, status: 'wat' }, { isAdmin: false, tablesMissing: false });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.needsRequest, true);
});

test('миграция не применена: админ входит с предупреждением', () => {
  const d = decide(null, { isAdmin: true, tablesMissing: true });
  assert.strictEqual(d.allow, true, 'иначе применить миграцию будет некому');
  assert.strictEqual(d.setup, true);
  assert.strictEqual(d.reason, 'tables_missing');
  assert.strictEqual(d.needsRequest, false, 'писать в отсутствующую таблицу нельзя');
  assert.ok(/sql-device-approvals/.test(d.message), 'сообщение подсказывает файл миграции');
});

test('миграция не применена: обычный пользователь не входит (fail closed)', () => {
  const d = decide(null, { isAdmin: false, tablesMissing: true });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.setup, true);
  assert.strictEqual(d.needsRequest, false);
});

test('tablesMissing имеет приоритет над строкой устройства', () => {
  const d = decide({ id: 1, status: 'approved' }, { isAdmin: false, tablesMissing: true });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, 'tables_missing');
});

test('отсутствующий opts не роняет функцию', () => {
  const d = decide(null);
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.needsRequest, true);
});

console.log('\nisSessionStale:');

const okSession = {
  login: 'ivan',
  device_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  session_version: 3,
  logged_in_at: '2026-07-31T10:00:00.000Z',
};

test('нет сессии → нечего аннулировать', () => {
  assert.strictEqual(isStale(null, { session_version: 5 }), false);
  assert.strictEqual(isStale(undefined, null), false);
});

test('сессия старого формата (без device_id) → аннулируется без сервера', () => {
  assert.strictEqual(isStale({ login: 'ivan', session_version: 3 }, null), true);
});

test('сессия без session_version → аннулируется', () => {
  assert.strictEqual(isStale({ login: 'ivan', device_id: 'aaaaaaaaaaaaaaaa' }, null), true);
});

test('session_version = 0 считается валидным (не путается с отсутствием)', () => {
  const s = Object.assign({}, okSession, { session_version: 0 });
  assert.strictEqual(isStale(s, null), false);
  assert.strictEqual(isStale(s, { session_version: 0 }), false);
  assert.strictEqual(isStale(s, { session_version: 1 }), true);
});

test('сервер недоступен (security = null) → сессия сохраняется', () => {
  assert.strictEqual(isStale(okSession, null), false);
});

test('версии совпадают → сессия валидна', () => {
  assert.strictEqual(isStale(okSession, { session_version: 3, force_logout_at: null }), false);
});

test('версия на сервере выросла → сессия аннулируется', () => {
  assert.strictEqual(isStale(okSession, { session_version: 4 }), true);
});

test('версия как строка сравнивается численно', () => {
  assert.strictEqual(isStale(okSession, { session_version: '3' }), false);
  assert.strictEqual(isStale(okSession, { session_version: '4' }), true);
});

test('force_logout_at позже входа → сессия аннулируется', () => {
  assert.strictEqual(isStale(okSession, {
    session_version: 3,
    force_logout_at: '2026-07-31T12:00:00.000Z',
  }), true);
});

test('force_logout_at раньше входа → сессия валидна', () => {
  assert.strictEqual(isStale(okSession, {
    session_version: 3,
    force_logout_at: '2026-07-31T08:00:00.000Z',
  }), false);
});

test('force_logout_at при отсутствии logged_in_at → сессия аннулируется', () => {
  const s = Object.assign({}, okSession);
  delete s.logged_in_at;
  assert.strictEqual(isStale(s, { session_version: 3, force_logout_at: '2026-07-31T08:00:00.000Z' }), true);
});

test('битая дата force_logout_at не выкидывает пользователя', () => {
  assert.strictEqual(isStale(okSession, { session_version: 3, force_logout_at: 'не дата' }), false);
});

console.log('\nisTableMissingError:');

test('404 / PGRST205 / «does not exist» → миграция не применена', () => {
  ['HTTP 404', 'HTTP 404: not found', 'PGRST205: no table',
   'Could not find the table \'public.crm_approved_devices\'',
   'relation "crm_approved_devices" does not exist',
  ].forEach(m => assert.strictEqual(isMissing(new Error(m)), true, m));
});

test('прочие ошибки не трактуются как отсутствие таблиц', () => {
  ['HTTP 401', 'HTTP 500', 'Failed to fetch', 'HTTP 409: duplicate key',
  ].forEach(m => assert.strictEqual(isMissing(new Error(m)), false, m));
});

test('null / строка вместо Error не роняют функцию', () => {
  assert.strictEqual(isMissing(null), false);
  assert.strictEqual(isMissing('HTTP 404'), true);
});

console.log('\nnormalizeDeviceId:');

test('валидный UUID сохраняется', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.strictEqual(normalizeId(id), id);
});

test('валидный hex (32 символа) сохраняется', () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.strictEqual(normalizeId(id), id);
});

test('мусор и слишком короткие значения отбрасываются', () => {
  ['', null, undefined, 'abc', '<script>', 'a'.repeat(65), 'zzzzzzzzzzzzzzzzzz',
  ].forEach(v => assert.strictEqual(normalizeId(v), null, String(v)));
});

console.log('\nshortDeviceId:');

test('длинный id сокращается, короткий остаётся как есть', () => {
  assert.strictEqual(shortId('abc'), 'abc');
  assert.strictEqual(shortId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeee1234'), 'aaaaaaaa…1234');
  assert.strictEqual(shortId(null), '—');
});

console.log('\nsummarizeUserAgent:');

test('Chrome на Windows', () => {
  assert.strictEqual(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), 'Chrome 120 · Windows');
});

test('Edge не определяется как Chrome (порядок проверок)', () => {
  assert.strictEqual(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91'), 'Edge 120 · Windows');
});

test('Safari на iPhone', () => {
  assert.strictEqual(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
    'Safari 17 · iOS');
});

test('Chrome на Android', () => {
  assert.strictEqual(uaSummary('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36'), 'Chrome 121 · Android');
});

test('Firefox на Linux', () => {
  assert.strictEqual(uaSummary('Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0'),
    'Firefox 122 · Linux');
});

test('пустой UA → понятная заглушка', () => {
  assert.strictEqual(uaSummary(''), 'неизвестный браузер');
  assert.strictEqual(uaSummary(null), 'неизвестный браузер');
});

console.log(`\nИтого: ${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
