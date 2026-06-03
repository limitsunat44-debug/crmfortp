#!/usr/bin/env node
'use strict';

/**
 * sync-sales.js — серверная синхронизация продаж в CRM Supabase.
 *
 * Источники:
 *   - 1С OData          → crm_doctors + crm_onec_sales_cache
 *   - DocSales Supabase → crm_docsales_sales_cache
 *
 * Цель: CRM Supabase (CRM_SUPABASE_URL / CRM_SERVICE_ROLE_KEY).
 *
 * Все секреты берутся ИСКЛЮЧИТЕЛЬНО из переменных окружения.
 * В коде нет ни одного захардкоженного ключа/пароля/URL.
 *
 * Запуск:
 *   node scripts/sync-sales.js --start=2025-01-01 --end=2025-01-31
 *   node scripts/sync-sales.js --start=2025-01-01 --end=2025-01-31 --source=1c
 *   node scripts/sync-sales.js --start=2025-01-01 --end=2025-01-31 --source=docsales
 *
 * Требует Node >= 18 (используется встроенный global fetch).
 */

// --- Константы 1С (это идентификаторы справочников, НЕ секреты) -------------
const ONEC_FOLDER_KEY = '37292452-0e5b-11ee-879c-d8c0a681cbca';
const ONEC_KIND_KEY = '37292453-0e5b-11ee-879c-d8c0a681cbca';
const ONEC_PAGE_SIZE = 1000;

// ===========================================================================
// Утилиты
// ===========================================================================

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function warn(...args) {
  console.warn(new Date().toISOString(), 'WARN', ...args);
}

function fail(message) {
  console.error(new Date().toISOString(), 'ERROR', message);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) fail(`Не задана переменная окружения ${name}`);
  return v;
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Безопасный парс числа из 1С/DocSales (строка "1 234,56" → 1234.56). */
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Дата-время начала/конца суток в формате OData edm.DateTime. */
function odataPeriodBounds(start, end) {
  return {
    from: `${start}T00:00:00`,
    to: `${end}T23:59:59`,
  };
}

function inPeriod(periodIso, fromIso, toIso) {
  if (!periodIso) return false;
  const t = Date.parse(periodIso);
  return Number.isFinite(t) && t >= Date.parse(fromIso) && t <= Date.parse(toIso);
}

// ===========================================================================
// HTTP-обёртки
// ===========================================================================

async function fetchJson(url, options, label) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    throw new Error(`${label}: сетевая ошибка ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error(`${label}: невалидный JSON — ${text.slice(0, 300)}`);
  }
}

// ===========================================================================
// 1С OData
// ===========================================================================

function onecAuthHeader() {
  const user = requireEnv('ONEC_BASIC_USER');
  const pass = requireEnv('ONEC_BASIC_PASSWORD');
  const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function onecBaseUrl() {
  return requireEnv('ONEC_ODATA_URL').replace(/\/+$/, '');
}

/**
 * Постраничная выгрузка сущности OData через $top/$skip.
 * $filter по Period/Description/Parent_Key в этой базе падает,
 * поэтому фильтрация делается в коде.
 */
async function onecFetchAll(entity, select) {
  const base = onecBaseUrl();
  const auth = onecAuthHeader();
  const rows = [];
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      $format: 'json',
      $top: String(ONEC_PAGE_SIZE),
      $skip: String(skip),
    });
    if (select) params.set('$select', select);
    const url = `${base}/${entity}?${params.toString()}`;
    const data = await fetchJson(
      url,
      { headers: { Authorization: auth, Accept: 'application/json' } },
      `1С ${entity} (skip=${skip})`
    );
    const batch = (data && data.value) || [];
    rows.push(...batch);
    log(`1С ${entity}: получено ${batch.length}, всего ${rows.length}`);
    if (batch.length < ONEC_PAGE_SIZE) break;
    skip += ONEC_PAGE_SIZE;
  }
  return rows;
}

/** Врачебные дисконтные карты: Parent_Key == folder OR ВидДисконтнойКарты_Key == kind. */
async function onecFetchDoctors() {
  const cards = await onecFetchAll('Catalog_ИнформационныеКарты');
  const doctors = new Map(); // discount_card_ref -> doctor
  for (const c of cards) {
    const parentKey = c.Parent_Key;
    const kindKey = c.ВидДисконтнойКарты_Key;
    const isDoctorCard = parentKey === ONEC_FOLDER_KEY || kindKey === ONEC_KIND_KEY;
    if (!isDoctorCard) continue;

    const ref = c.Ref_Key;
    if (!ref) continue;
    const doctorCode = (c.КодКарты && String(c.КодКарты).trim()) || (c.Code && String(c.Code).trim()) || ref;
    const doctorName = (c.Description && String(c.Description).trim()) || '';
    doctors.set(ref, {
      discount_card_ref: ref,
      doctor_code: doctorCode,
      doctor_name: doctorName,
    });
  }
  log(`1С: отобрано врачебных карт: ${doctors.size}`);
  return doctors;
}

/**
 * Продажи по дисконтным картам за период, агрегированные по карте.
 * amount = sum(Сумма); quantity = sum(Количество);
 * checks_count = count(distinct Recorder) (fallback: count строк).
 * Учитываются только Active === true.
 */
async function onecFetchSales(start, end) {
  const { from, to } = odataPeriodBounds(start, end);
  const rows = await onecFetchAll('AccumulationRegister_ПродажиПоДисконтнымКартам_RecordType');

  const agg = new Map(); // ref -> {amount, quantity, recorders:Set, rowCount}
  for (const r of rows) {
    if (r.Active !== true) continue;
    if (!inPeriod(r.Period, from, to)) continue;
    const ref = r.ДисконтнаяКарта_Key;
    if (!ref) continue;
    let a = agg.get(ref);
    if (!a) {
      a = { amount: 0, quantity: 0, recorders: new Set(), rowCount: 0 };
      agg.set(ref, a);
    }
    a.amount += toNumber(r.Сумма);
    a.quantity += toNumber(r.Количество);
    a.rowCount += 1;
    if (r.Recorder) a.recorders.add(String(r.Recorder));
  }
  log(`1С: агрегировано продаж по картам: ${agg.size}`);
  return agg;
}

async function syncOneC(crm, start, end) {
  log('=== 1С: старт ===');
  const doctors = await onecFetchDoctors();
  const sales = await onecFetchSales(start, end);

  // Справочник врачей
  const doctorRows = [...doctors.values()].map((d) => ({
    doctor_code: d.doctor_code,
    doctor_name: d.doctor_name,
    discount_card_ref: d.discount_card_ref,
    discount_card_code: d.doctor_code,
    source: 'onec',
    discount_group: 'для учета',
    active: true,
    last_synced_at: new Date().toISOString(),
  }));
  if (doctorRows.length) {
    await crm.upsert('crm_doctors', doctorRows, 'doctor_code');
  }

  // Кэш продаж
  const salesRows = [];
  for (const [ref, a] of sales.entries()) {
    const doc = doctors.get(ref);
    const doctorCode = doc ? doc.doctor_code : ref;
    salesRows.push({
      doctor_code: doctorCode,
      period_start: start,
      period_end: end,
      amount: Number(a.amount.toFixed(2)),
      checks_count: a.recorders.size > 0 ? a.recorders.size : a.rowCount,
      raw: {
        discount_card_ref: ref,
        doctor_name: doc ? doc.doctor_name : null,
        quantity: Number(a.quantity.toFixed(3)),
      },
      synced_at: new Date().toISOString(),
    });
  }
  if (salesRows.length) {
    await crm.upsert('crm_onec_sales_cache', salesRows, 'doctor_code,period_start,period_end');
  }
  log(`=== 1С: готово (врачей ${doctorRows.length}, продаж ${salesRows.length}) ===`);
  return doctorRows.length + salesRows.length;
}

// ===========================================================================
// DocSales (Supabase REST)
// ===========================================================================

function docsalesClient() {
  const url = requireEnv('DOCSALES_SUPABASE_URL').replace(/\/+$/, '');
  const key = requireEnv('DOCSALES_SERVICE_ROLE_KEY');
  return supabaseRest(url, key);
}

/**
 * Гибкий адаптер DocSales: схема может отличаться, поэтому всё необязательное.
 * Пытаемся: visits(+visit_items) -> сумма; doctor_code из visits/doctors.
 * При несовпадении структуры — логируем и возвращаем пустой результат,
 * НЕ падаем.
 */
async function syncDocSales(crm, start, end) {
  log('=== DocSales: старт ===');
  const ds = docsalesClient();

  let visits = [];
  try {
    visits = await ds.select('visits', {
      select: '*',
      filter: `visit_date=gte.${start}&visit_date=lte.${end}`,
    });
  } catch (e) {
    // Возможно, поле даты называется иначе — пробуем без фильтра по дате.
    warn(`DocSales: фильтр по visit_date не сработал (${e.message}), пробую created_at`);
    try {
      visits = await ds.select('visits', {
        select: '*',
        filter: `created_at=gte.${start}T00:00:00&created_at=lte.${end}T23:59:59`,
      });
    } catch (e2) {
      warn(`DocSales: не удалось прочитать visits (${e2.message}). Пропускаю источник.`);
      log('=== DocSales: пропущено (нет совместимой схемы) ===');
      return 0;
    }
  }

  if (!Array.isArray(visits) || visits.length === 0) {
    log('DocSales: визитов за период не найдено.');
    log('=== DocSales: готово (0) ===');
    return 0;
  }

  // Справочник врачей DocSales (для кода/имени), если таблица есть.
  let doctorsById = new Map();
  try {
    const docs = await ds.select('doctors', { select: '*' });
    for (const d of docs) {
      const code = d.doctor_code || d.code || d.id;
      doctorsById.set(String(d.id), {
        code: code != null ? String(code) : null,
        name: d.name || d.doctor_name || d.full_name || null,
      });
    }
  } catch (e) {
    warn(`DocSales: таблица doctors недоступна (${e.message}), беру коды из visits.`);
  }

  // Позиции визитов (сумма) — если таблица visit_items есть.
  const amountByVisit = new Map();
  try {
    const items = await ds.select('visit_items', { select: '*' });
    for (const it of items) {
      const vid = String(it.visit_id);
      amountByVisit.set(vid, (amountByVisit.get(vid) || 0) + toNumber(it.amount));
    }
  } catch (e) {
    warn(`DocSales: visit_items недоступна (${e.message}), беру сумму из visits.total.`);
  }

  // Агрегация по врачу.
  const agg = new Map(); // doctor_code -> {name, amount, checks:Set}
  for (const v of visits) {
    const did = v.doctor_id != null ? String(v.doctor_id) : null;
    const dim = did ? doctorsById.get(did) : null;
    const doctorCode =
      (v.doctor_code && String(v.doctor_code)) ||
      (dim && dim.code) ||
      did ||
      'unknown';
    const doctorName =
      (v.doctor_name && String(v.doctor_name)) ||
      (dim && dim.name) ||
      null;

    const itemsAmount = amountByVisit.get(String(v.id));
    const amount = itemsAmount != null ? itemsAmount : toNumber(v.total ?? v.amount ?? v.sum);

    let a = agg.get(doctorCode);
    if (!a) {
      a = { name: doctorName, amount: 0, checks: new Set() };
      agg.set(doctorCode, a);
    }
    if (!a.name && doctorName) a.name = doctorName;
    a.amount += amount;
    a.checks.add(String(v.id));
  }

  const rows = [...agg.entries()].map(([code, a]) => ({
    doctor_code: code,
    doctor_name: a.name,
    period_start: start,
    period_end: end,
    amount: Number(a.amount.toFixed(2)),
    checks_count: a.checks.size,
    raw: {
      source: 'docsales',
    },
    synced_at: new Date().toISOString(),
  }));

  if (rows.length) {
    await crm.upsert('crm_docsales_sales_cache', rows, 'doctor_code,period_start,period_end');
  }
  log(`=== DocSales: готово (врачей ${rows.length}) ===`);
  return rows.length;
}

// ===========================================================================
// CRM Supabase (целевой)
// ===========================================================================

/** Лёгкий клиент Supabase REST (PostgREST) без зависимостей. */
function supabaseRest(url, serviceRoleKey) {
  const base = `${url}/rest/v1`;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  return {
    async select(table, { select = '*', filter = '' } = {}) {
      const qs = `select=${encodeURIComponent(select)}${filter ? `&${filter}` : ''}`;
      return fetchJson(`${base}/${table}?${qs}`, { headers: { ...headers } }, `Supabase select ${table}`);
    },

    /** Upsert по on_conflict с разрешением конфликта (merge-duplicates). */
    async upsert(table, rows, onConflict) {
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
        await fetchJson(
          `${base}/${table}${qs}`,
          {
            method: 'POST',
            headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(chunk),
          },
          `Supabase upsert ${table}`
        );
        log(`CRM upsert ${table}: записано ${chunk.length}`);
      }
    },

    async insert(table, row) {
      return fetchJson(
        `${base}/${table}`,
        {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify(row),
        },
        `Supabase insert ${table}`
      );
    },

    async patch(table, filter, row) {
      return fetchJson(
        `${base}/${table}?${filter}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        },
        `Supabase patch ${table}`
      );
    },
  };
}

function crmClient() {
  const url = requireEnv('CRM_SUPABASE_URL').replace(/\/+$/, '');
  const key = requireEnv('CRM_SERVICE_ROLE_KEY');
  return supabaseRest(url, key);
}

// ===========================================================================
// Журнал запусков (best-effort)
// ===========================================================================

async function startRun(crm, source, start, end) {
  try {
    const res = await crm.insert('crm_sync_runs', {
      source,
      period_start: start,
      period_end: end,
      status: 'partial',
      started_at: new Date().toISOString(),
    });
    return res && res[0] ? res[0].id : null;
  } catch (e) {
    warn(`Не удалось создать запись crm_sync_runs (${e.message}). Продолжаю без журнала.`);
    return null;
  }
}

async function finishRun(crm, runId, status, rowsWritten, message) {
  if (!runId) return;
  try {
    await crm.patch('crm_sync_runs', `id=eq.${runId}`, {
      status,
      rows_written: rowsWritten,
      message: message ? String(message).slice(0, 1000) : null,
      finished_at: new Date().toISOString(),
    });
  } catch (e) {
    warn(`Не удалось обновить crm_sync_runs (${e.message}).`);
  }
}

// ===========================================================================
// main
// ===========================================================================

async function main() {
  const args = parseArgs(process.argv);
  const start = args.start;
  const end = args.end;
  const source = (args.source || 'all').toLowerCase();

  if (!isValidDate(start) || !isValidDate(end)) {
    fail('Нужны корректные --start=YYYY-MM-DD и --end=YYYY-MM-DD');
  }
  if (Date.parse(start) > Date.parse(end)) {
    fail('--start не может быть позже --end');
  }
  if (!['all', '1c', 'docsales'].includes(source)) {
    fail(`Неизвестный --source=${source} (ожидается all | 1c | docsales)`);
  }

  log(`Старт синхронизации: source=${source}, период ${start}..${end}`);
  const crm = crmClient();
  const runId = await startRun(crm, source, start, end);

  let rowsWritten = 0;
  const errors = [];

  if (source === 'all' || source === '1c') {
    try {
      rowsWritten += await syncOneC(crm, start, end);
    } catch (e) {
      errors.push(`1С: ${e.message}`);
      warn(`Источник 1С завершился с ошибкой: ${e.message}`);
    }
  }

  if (source === 'all' || source === 'docsales') {
    try {
      rowsWritten += await syncDocSales(crm, start, end);
    } catch (e) {
      errors.push(`DocSales: ${e.message}`);
      warn(`Источник DocSales завершился с ошибкой: ${e.message}`);
    }
  }

  const status = errors.length === 0 ? 'ok' : 'partial';
  await finishRun(crm, runId, status, rowsWritten, errors.join(' | '));

  log(`Готово. Статус=${status}, записано строк=${rowsWritten}.`);
  if (errors.length) {
    warn(`Завершено с ошибками источников:\n - ${errors.join('\n - ')}`);
    process.exit(2);
  }
}

main().catch((e) => {
  fail(`Непредвиденная ошибка: ${e && e.stack ? e.stack : e}`);
});
