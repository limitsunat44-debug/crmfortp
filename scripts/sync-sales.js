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

// --- Сетевые параметры (настраиваются через env, имеют безопасные дефолты) ---
// Таймаут одного HTTP-запроса. 1С отдаёт большие страницы регистра медленно,
// поэтому дефолт щедрый (120с). Можно поднять через HTTP_TIMEOUT_MS.
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 120000;
// Сколько раз повторять запрос при сетевой ошибке/таймауте/5xx.
const HTTP_RETRIES = Number(process.env.HTTP_RETRIES) || 4;
// Базовая задержка экспоненциального backoff между повторами (мс).
const HTTP_RETRY_BASE_MS = Number(process.env.HTTP_RETRY_BASE_MS) || 1500;
// Минимальный размер страницы 1С при адаптивном уменьшении на таймаутах.
const ONEC_MIN_PAGE_SIZE = Number(process.env.ONEC_MIN_PAGE_SIZE) || 250;

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

/** Нормализация имени врача для матчинга (регистр, пробелы, ё→е). */
function normalizeName(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Расстояние Левенштейна между двумя строками (итеративно, O(n·m)). */
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j += 1) prev[j] = j;
  for (let i = 1; i <= al; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bl];
}

/**
 * Нечёткий матчинг нормализованного имени к справочнику CRM-врачей.
 * Сначала ищется точное совпадение; если его нет — ближайшее по расстоянию
 * Левенштейна в пределах безопасного порога (≈10% длины, но не более 2 правок).
 * Порог сознательно консервативен, чтобы не склеивать разных врачей:
 * "курбонова райфа" ↔ "курбанова райфа" (1 правка) совпадут,
 * а явно различающиеся имена — нет.
 * Возвращает { code, name, fuzzy } или null.
 */
function fuzzyMatchDoctor(normName, crmIndex) {
  if (!normName) return null;
  const exact = crmIndex.byName.get(normName);
  if (exact) return { code: exact.code, name: exact.name, fuzzy: false };

  const maxDist = Math.min(2, Math.floor(normName.length * 0.1));
  if (maxDist < 1) return null;

  let best = null;
  let bestDist = maxDist + 1;
  for (const entry of crmIndex.list) {
    // Быстрая отсечка по разнице длины.
    if (Math.abs(entry.norm.length - normName.length) > maxDist) continue;
    const d = levenshtein(normName, entry.norm);
    if (d < bestDist) {
      bestDist = d;
      best = entry;
      if (d === 0) break;
    }
  }
  if (best && bestDist <= maxDist) {
    return { code: best.code, name: best.name, fuzzy: true, distance: bestDist };
  }
  return null;
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

/** Извлекает день (YYYY-MM-DD) из значения даты/даты-времени. null при неудаче. */
function toDay(value) {
  if (!value) return null;
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// ===========================================================================
// HTTP-обёртки
// ===========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ошибка, по которой имеет смысл повторить запрос (сеть/таймаут/5xx/429). */
function isRetryable(err) {
  if (err && err.retryable) return true;
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('terminated') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('und_err')
  );
}

/**
 * Один HTTP-запрос с таймаутом через AbortController и разбором JSON.
 * Бросает Error с .retryable=true для 5xx/429, чтобы вызывающий мог повторить.
 */
async function fetchJsonOnce(url, options, label, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || controller.signal.aborted);
    const err = new Error(
      `${label}: ${aborted ? `таймаут ${timeoutMs}мс` : `сетевая ошибка ${e.message}`}`
    );
    err.retryable = true; // сеть/таймаут всегда повторяемы
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${label}: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
    if (res.status >= 500 || res.status === 429) err.retryable = true;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error(`${label}: невалидный JSON — ${text.slice(0, 300)}`);
  }
}

/**
 * fetchJson с таймаутом и экспоненциальным backoff по повторяемым ошибкам.
 * timeoutMs/retries можно переопределить per-call (для тяжёлых страниц 1С).
 */
async function fetchJson(url, options, label, { timeoutMs = HTTP_TIMEOUT_MS, retries = HTTP_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJsonOnce(url, options, label, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (attempt >= retries || !isRetryable(e)) throw e;
      const backoff = HTTP_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500);
      warn(`${label}: попытка ${attempt + 1}/${retries + 1} не удалась (${e.message}); повтор через ${backoff}мс`);
      await sleep(backoff);
    }
  }
  throw lastErr;
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
 * Постраничная выгрузка сущности OData через $top/$skip с устойчивостью к
 * медленным/обрывающимся страницам большого регистра.
 *
 * $filter по Period/Description/Parent_Key в этой базе исторически падает,
 * поэтому фильтрация по-прежнему делается в коде (см. onecFetchSales).
 *
 * Особенности:
 *   • таймаут+ретраи на уровне fetchJson;
 *   • адаптивное уменьшение размера страницы, если страница стабильно
 *     обрывается по таймауту (1С отдаёт большие top медленно) — это часто
 *     помогает, когда фиксированный $top=1000 не успевает отдаться;
 *   • опциональный onPage(batch, skip) — позволяет потоково обрабатывать/
 *     сохранять страницы, не теряя уже выгруженное при поздней ошибке.
 */
async function onecFetchAll(entity, select, onPage, rawFilter) {
  const base = onecBaseUrl();
  const auth = onecAuthHeader();
  const rows = [];
  let skip = 0;
  let pageSize = ONEC_PAGE_SIZE;
  for (;;) {
    const params = new URLSearchParams({
      $format: 'json',
      $top: String(pageSize),
      $skip: String(skip),
    });
    if (select) params.set('$select', select);
    // rawFilter — уже собранное выражение OData ($filter=...), добавляем как
    // есть, чтобы не ломать кодировку datetime'...' двойным энкодингом.
    const extra = rawFilter ? `&${rawFilter}` : '';
    const url = `${base}/${entity}?${params.toString()}${extra}`;

    let data;
    try {
      data = await fetchJson(
        url,
        { headers: { Authorization: auth, Accept: 'application/json' } },
        `1С ${entity} (skip=${skip}, top=${pageSize})`
      );
    } catch (e) {
      // Если страница не вытягивается, а размер ещё можно уменьшить — пробуем
      // меньший $top с того же skip. Это спасает выгрузки, где большой top
      // стабильно обрывается ("terminated") около середины регистра.
      if (isRetryable(e) && pageSize > ONEC_MIN_PAGE_SIZE) {
        const next = Math.max(ONEC_MIN_PAGE_SIZE, Math.floor(pageSize / 2));
        warn(`1С ${entity}: страница top=${pageSize} не отдалась (${e.message}); уменьшаю top до ${next} и повторяю с skip=${skip}`);
        pageSize = next;
        continue;
      }
      throw e;
    }

    const batch = (data && data.value) || [];
    rows.push(...batch);
    if (onPage) await onPage(batch, skip);
    log(`1С ${entity}: получено ${batch.length} (skip=${skip}, top=${pageSize}), всего ${rows.length}`);
    if (batch.length < pageSize) break;
    skip += batch.length;
  }
  log(`1С ${entity}: выгрузка завершена, всего строк ${rows.length}`);
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
 * Продажи по дисконтным картам за период, агрегированные по карте И ДНЮ продажи.
 * Ключ агрегата: `${ref}|${day}`, где day = YYYY-MM-DD из r.Period.
 * Это даёт детальные строки на каждый день, чтобы фронт мог суммировать
 * произвольный диапазон дат (а не только целые предзаданные периоды).
 * amount = sum(Сумма); quantity = sum(Количество);
 * checks_count = count(distinct Recorder) (fallback: count строк).
 * Учитываются только Active === true.
 */
const ONEC_SALES_ENTITY = 'AccumulationRegister_ПродажиПоДисконтнымКартам_RecordType';

/**
 * Пытается выгрузить регистр продаж с СЕРВЕРНЫМ фильтром по Period.
 * В этой базе $filter исторически нестабилен, поэтому это best-effort:
 * при ЛЮБОЙ ошибке (включая HTTP-ошибку 1С на неподдерживаемый $filter)
 * возвращаем null, и вызывающий откатывается на полную выгрузку + локальную
 * фильтрацию. Серверный фильтр, когда он работает, резко уменьшает объём
 * (одна дата вместо всего регистра) и устраняет обрывы около 4k строк.
 */
async function onecTryFetchSalesFiltered(from, to) {
  const filter = `Period ge datetime'${from}' and Period le datetime'${to}'`;
  try {
    const rows = await onecFetchAll(
      ONEC_SALES_ENTITY,
      null,
      null,
      `$filter=${encodeURIComponent(filter)}`
    );
    log(`1С: серверный $filter по Period сработал, строк ${rows.length}`);
    return rows;
  } catch (e) {
    warn(`1С: серверный $filter по Period не поддерживается/не сработал (${e.message}); откат на полную выгрузку с локальной фильтрацией`);
    return null;
  }
}

async function onecFetchSales(start, end) {
  const { from, to } = odataPeriodBounds(start, end);
  // Сначала пробуем серверный фильтр (дёшево и быстро), затем — полный обход.
  let rows = await onecTryFetchSalesFiltered(from, to);
  let serverFiltered = rows != null;
  if (!serverFiltered) {
    rows = await onecFetchAll(ONEC_SALES_ENTITY);
  }

  // key `${ref}|${day}` -> {ref, day, amount, quantity, recorders:Set, rowCount}
  const agg = new Map();
  let inPeriodCount = 0;
  for (const r of rows) {
    if (r.Active !== true) continue;
    // Период всё равно проверяем локально: даже при серверном фильтре граница
    // может отличаться, а при полной выгрузке это обязательная отсечка.
    if (!inPeriod(r.Period, from, to)) continue;
    inPeriodCount += 1;
    const ref = r.ДисконтнаяКарта_Key;
    if (!ref) continue;
    const day = toDay(r.Period);
    if (!day) continue;
    const key = `${ref}|${day}`;
    let a = agg.get(key);
    if (!a) {
      a = { ref, day, amount: 0, quantity: 0, recorders: new Set(), rowCount: 0 };
      agg.set(key, a);
    }
    a.amount += toNumber(r.Сумма);
    a.quantity += toNumber(r.Количество);
    a.rowCount += 1;
    if (r.Recorder) a.recorders.add(String(r.Recorder));
  }
  log(
    `1С: продажи (${serverFiltered ? 'серверный фильтр' : 'полная выгрузка'}): ` +
      `строк всего ${rows.length}, в периоде ${inPeriodCount}, агрегатов карта×день ${agg.size}`
  );
  return agg;
}

async function syncOneC(crm, start, end) {
  log('=== 1С: старт ===');
  const doctors = await onecFetchDoctors();

  // Справочник врачей пишем СРАЗУ, до выгрузки продаж. Так даже если тяжёлая
  // выгрузка регистра продаж оборвётся, обновлённый справочник уже сохранён
  // и не теряется (раньше при ошибке продаж в CRM не попадало вообще ничего).
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

  const sales = await onecFetchSales(start, end);

  // Кэш продаж: одна строка на врача×день (period_start=period_end=sale_date=day).
  // День-уровневые строки позволяют фронту суммировать любой диапазон дат.
  const salesRows = [];
  for (const a of sales.values()) {
    const doc = doctors.get(a.ref);
    const doctorCode = doc ? doc.doctor_code : a.ref;
    salesRows.push({
      doctor_code: doctorCode,
      period_start: a.day,
      period_end: a.day,
      sale_date: a.day,
      amount: Number(a.amount.toFixed(2)),
      checks_count: a.recorders.size > 0 ? a.recorders.size : a.rowCount,
      raw: {
        discount_card_ref: a.ref,
        doctor_name: doc ? doc.doctor_name : null,
        quantity: Number(a.quantity.toFixed(3)),
        granularity: 'day',
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
 * Загрузка справочника врачей CRM (doctor_code + doctor_name) для матчинга
 * по нормализованному имени (точному и нечёткому).
 * Возвращает индекс { byName: Map norm->{code,name}, list: [{norm,code,name}] }.
 * Best-effort: при ошибке возвращает пустой индекс и логирует предупреждение.
 */
async function crmFetchDoctorsByName(crm) {
  const byName = new Map();
  const list = [];
  try {
    const docs = await crm.select('crm_doctors', { select: 'doctor_code,doctor_name' });
    for (const d of docs || []) {
      const key = normalizeName(d.doctor_name);
      if (key && d.doctor_code != null && !byName.has(key)) {
        const entry = { norm: key, code: String(d.doctor_code), name: d.doctor_name || null };
        byName.set(key, entry);
        list.push(entry);
      }
    }
    log(`CRM: загружено врачей для матчинга по имени: ${byName.size}`);
  } catch (e) {
    warn(`CRM: не удалось загрузить crm_doctors для матчинга (${e.message}).`);
  }
  return { byName, list };
}

/**
 * Источник docsales2 (visits + visit_items + doctors).
 * Возвращает Map doctor_code -> {name, amount, checks:Set, sources:Set}.
 * При несовпадении схемы логирует и возвращает пустую Map, НЕ падает.
 *
 * СХЕМА docsales2 (актуальная, приложение docsales2.vercel.app):
 *   visits:      { id, patient_id, salon_id, doctor_id (int FK -> doctors.id),
 *                  diagnosis_id, comment, status, visit_at (timestamptz),
 *                  completed_at, created_by }  — суммы в visits НЕТ.
 *   visit_items: { id, visit_id (FK -> visits.id), name, amount (float) }
 *                  — реальная сумма визита = SUM(visit_items.amount).
 *   doctors:     { id, name, ... }
 *
 * Историческое отличие: раньше дата бралась из visit_date/created_at, а сумма из
 * visits.total. После перехода docsales2 на новую схему дата хранится в visit_at,
 * а сумма — только в visit_items.amount. Ниже поддержаны ОБЕ схемы, но приоритет
 * у актуальной (visit_at + visit_items).
 */
async function aggregateDocSalesVisits(ds, start, end) {
  const agg = new Map();

  // Дата визита. Актуальная схема — visit_at (timestamptz). Фильтруем по
  // полной границе суток, чтобы не терять визиты с временем в течение
  // последнего дня периода. Последовательно пробуем поля даты; при ошибке
  // (поля нет / фильтр не поддержан) переходим к следующему кандидату.
  const dateFields = ['visit_at', 'visit_date', 'completed_at', 'created_at'];
  let visits = [];
  let usedDateField = null;
  for (const field of dateFields) {
    try {
      visits = await ds.select('visits', {
        select: '*',
        filter: `${field}=gte.${start}T00:00:00&${field}=lte.${end}T23:59:59`,
      });
      usedDateField = field;
      break;
    } catch (e) {
      warn(`DocSales(visits): фильтр по ${field} не сработал (${e.message}), пробую следующее поле даты`);
    }
  }
  if (usedDateField == null) {
    warn('DocSales(visits): не удалось прочитать visits ни по одному полю даты. Пропускаю источник.');
    return agg;
  }
  log(`DocSales(visits): визиты отфильтрованы по полю ${usedDateField}, строк ${Array.isArray(visits) ? visits.length : 0}`);

  if (!Array.isArray(visits) || visits.length === 0) {
    log('DocSales(visits): визитов за период не найдено.');
    return agg;
  }

  // Справочник врачей DocSales (для кода/имени), если таблица есть.
  const doctorsById = new Map();
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
    warn(`DocSales(visits): таблица doctors недоступна (${e.message}), беру коды из visits.`);
  }

  // Позиции визитов (сумма). В актуальной схеме сумма визита = SUM(amount)
  // по visit_items. Читаем позиции ТОЛЬКО за нужные визиты (фильтр по visit_id
  // in.(...)), чтобы не тянуть всю таблицу и не смешивать чужие периоды.
  // Ключи Map — строковые (id из PostgREST может прийти числом или строкой).
  const amountByVisit = new Map();
  const visitIds = visits.map((v) => v.id).filter((id) => id != null);
  try {
    // PostgREST in.(...) — разбиваем на чанки, чтобы не упереться в длину URL.
    const chunkSize = 200;
    for (let i = 0; i < visitIds.length; i += chunkSize) {
      const chunk = visitIds.slice(i, i + chunkSize);
      const inList = chunk.map((id) => String(id)).join(',');
      const items = await ds.select('visit_items', {
        select: 'visit_id,amount',
        filter: `visit_id=in.(${inList})`,
      });
      for (const it of items || []) {
        const vid = String(it.visit_id);
        amountByVisit.set(vid, (amountByVisit.get(vid) || 0) + toNumber(it.amount));
      }
    }
    log(`DocSales(visits): суммы по visit_items собраны для ${amountByVisit.size} визитов`);
  } catch (e) {
    warn(`DocSales(visits): visit_items недоступна (${e.message}), беру сумму из visits.total/amount/sum (легаси).`);
  }

  let zeroAmountVisits = 0;
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

    const day = toDay(v.visit_at ?? v.visit_date ?? v.completed_at ?? v.created_at ?? v.date);
    if (!day) continue;

    // Приоритет — сумма позиций visit_items; при её отсутствии легаси-fallback
    // на суммовые поля самого визита (для старой схемы).
    const itemsAmount = amountByVisit.get(String(v.id));
    const amount = itemsAmount != null ? itemsAmount : toNumber(v.total ?? v.amount ?? v.sum);
    if (!(amount > 0)) zeroAmountVisits += 1;

    const key = `${doctorCode}|${day}`;
    let a = agg.get(key);
    if (!a) {
      a = { code: doctorCode, day, name: doctorName, amount: 0, checks: new Set(), sources: new Set() };
      agg.set(key, a);
    }
    if (!a.name && doctorName) a.name = doctorName;
    a.amount += amount;
    a.checks.add(`visit:${v.id}`);
    a.sources.add('visits');
  }

  // Диагностика: если визиты есть, но у большинства сумма = 0 — это сигнал
  // рассогласования схемы (например, visit_items пуста/недоступна или сумма
  // хранится в другом поле). Логируем явно, чтобы такую регрессию было видно в логах.
  if (zeroAmountVisits > 0) {
    warn(`DocSales(visits): визитов с нулевой суммой: ${zeroAmountVisits} из ${visits.length}` +
      (amountByVisit.size === 0 ? ' (visit_items не дала сумм — проверьте схему/RLS таблицы visit_items)' : ''));
  }
  log(`DocSales(visits): агрегировано врачей×дней: ${agg.size}`);
  return agg;
}

/**
 * Источник docsales.vercel.app (таблица doctor_sales).
 * Строки: { id, store, doctor_name, product, quantity, price, total, sale_date }.
 * doctor_code отсутствует → матчим по нормализованному doctor_name из crm_doctors
 * (точно, затем нечётко в пределах безопасного порога — ё/е, пробелы, мелкие опечатки
 * вроде Курбонова/Курбанова).
 * Если совпадения нет — fallback `name:<normalized>`, raw содержит original имя.
 * Возвращает Map doctor_code -> {name, amount, checks:Set, sources:Set, unmatched:Set}.
 */
async function aggregateDoctorSales(ds, crmIndex, start, end) {
  const agg = new Map();

  let rows = [];
  try {
    // sale_date в doctor_sales — timestamptz (напр. 2026-06-25T15:08:02+00:00),
    // поэтому верхняя граница — конец суток end (T23:59:59), иначе lte.${end}
    // трактуется как ≤ end 00:00:00 и продажи в течение последнего дня теряются.
    rows = await ds.select('doctor_sales', {
      select: '*',
      filter: `sale_date=gte.${start}T00:00:00&sale_date=lte.${end}T23:59:59`,
    });
  } catch (e) {
    warn(`DocSales(doctor_sales): таблица недоступна или фильтр не сработал (${e.message}). Пропускаю источник.`);
    return agg;
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    log('DocSales(doctor_sales): продаж за период не найдено.');
    return agg;
  }

  let fuzzyCount = 0;
  for (const r of rows) {
    const rawName = r.doctor_name != null ? String(r.doctor_name).trim() : '';
    const normName = normalizeName(rawName);
    const match = normName ? fuzzyMatchDoctor(normName, crmIndex) : null;
    const matchedCode = match ? match.code : null;
    const doctorCode = matchedCode || (normName ? `name:${normName}` : 'unknown');
    if (match && match.fuzzy) {
      fuzzyCount += 1;
      log(`DocSales(doctor_sales): нечёткий матч "${rawName}" → ${match.code} ("${match.name}") dist=${match.distance}`);
    }

    const day = toDay(r.sale_date);
    if (!day) continue;

    const key = `${doctorCode}|${day}`;
    let a = agg.get(key);
    if (!a) {
      a = { code: doctorCode, day, name: rawName || null, amount: 0, checks: new Set(), sources: new Set(), unmatched: new Set() };
      agg.set(key, a);
    }
    if (!a.name && rawName) a.name = rawName;
    a.amount += toNumber(r.total);
    // Чек = запись продажи; если есть id — distinct по id, иначе по строке.
    a.checks.add(`doctor_sales:${r.id != null ? r.id : `${rawName}|${r.product}|${r.sale_date}`}`);
    a.sources.add('doctor_sales');
    if (!matchedCode && rawName) a.unmatched.add(rawName);
  }
  if (fuzzyCount) {
    log(`DocSales(doctor_sales): нечётких совпадений по имени: ${fuzzyCount}.`);
  }

  let unmatchedCount = 0;
  for (const a of agg.values()) if (a.unmatched && a.unmatched.size) unmatchedCount += 1;
  if (unmatchedCount) {
    warn(`DocSales(doctor_sales): врачей без совпадения в crm_doctors: ${unmatchedCount} (использован fallback name:<normalized>).`);
  }
  log(`DocSales(doctor_sales): агрегировано врачей: ${agg.size}`);
  return agg;
}

/**
 * Канонизация агрегатов DocSales по ИМЕНИ врача относительно crm_doctors.
 *
 * Проблема: DocSales-источники дают РАЗНЫЕ коды одного врача — числовой код
 * визитов/doctor_sales (например 673), fallback `name:<norm>` или код из
 * таблицы doctors DocSales. 1С при этом пишет стабильный CRM doctor_code
 * (например 510). Если не привести их к одному коду, во фронте получаются дубли.
 *
 * Правило (для ВСЕХ агрегатов, независимо от источника кода):
 *   • нормализуем doctor_name и ищем врача в crm_doctors (точно, затем нечётко
 *     в пределах консервативного порога Левенштейна);
 *   • если найден — ПЕРЕКЛЮЧАЕМ код агрегата на CRM doctor_code (даже если у
 *     строки уже есть числовой код); строки с тем же CRM-кодом×день сливаются;
 *   • если имя не совпало ни с кем — код НЕ трогаем (оставляем как есть, чтобы
 *     не склеить разных людей).
 *
 * Возвращает новый Map `${code}|${day}` -> aggregate с каноническими кодами.
 */
function canonicalizeDocSalesAggregates(merged, crmIndex) {
  if (!crmIndex || !crmIndex.list || crmIndex.list.length === 0) return merged;
  const out = new Map();
  let remapped = 0;
  for (const a of merged.values()) {
    const normName = normalizeName(a.name);
    const match = normName ? fuzzyMatchDoctor(normName, crmIndex) : null;
    let code = a.code;
    if (match && match.code && String(match.code) !== String(a.code)) {
      remapped += 1;
      log(
        `DocSales(canon): "${a.name}" код ${a.code} → CRM ${match.code}` +
          (match.fuzzy ? ` (нечётко dist=${match.distance})` : ' (точно)')
      );
      code = String(match.code);
    }
    const key = `${code}|${a.day}`;
    let t = out.get(key);
    if (!t) {
      t = { code, day: a.day, name: a.name, amount: 0, checks: new Set(), sources: new Set(), unmatched: new Set() };
      out.set(key, t);
    }
    if (!t.name && a.name) t.name = a.name;
    t.amount += a.amount;
    for (const c of a.checks) t.checks.add(c);
    for (const s of a.sources) t.sources.add(s);
    // Если имя совпало с CRM — это больше НЕ unmatched.
    if (!match && a.unmatched) for (const u of a.unmatched) t.unmatched.add(u);
  }
  if (remapped) log(`DocSales(canon): перекодировано агрегатов по имени к CRM-коду: ${remapped}.`);
  return out;
}

/** Слияние агрегатов нескольких источников DocSales аддитивно по doctor_code×день. */
function mergeDocSalesAggregates(...maps) {
  const merged = new Map(); // `${code}|${day}` -> {code, day, ...}
  for (const m of maps) {
    for (const [key, a] of m.entries()) {
      let t = merged.get(key);
      if (!t) {
        t = { code: a.code, day: a.day, name: a.name, amount: 0, checks: new Set(), sources: new Set(), unmatched: new Set() };
        merged.set(key, t);
      }
      if (!t.name && a.name) t.name = a.name;
      t.amount += a.amount;
      for (const c of a.checks) t.checks.add(c);
      for (const s of a.sources) t.sources.add(s);
      if (a.unmatched) for (const u of a.unmatched) t.unmatched.add(u);
    }
  }
  return merged;
}

/**
 * Адаптер DocSales: читает оба интерфейса —
 *   docsales2 (visits/visit_items) и docsales.vercel.app (doctor_sales).
 * Аддитивно объединяет суммы и чеки по doctor_code/period в один кэш-row.
 * При несовпадении любой схемы — логирует и продолжает с тем, что доступно.
 */
async function syncDocSales(crm, start, end) {
  log('=== DocSales: старт ===');
  const ds = docsalesClient();

  const crmIndex = await crmFetchDoctorsByName(crm);

  const visitsAgg = await aggregateDocSalesVisits(ds, start, end);
  const doctorSalesAgg = await aggregateDoctorSales(ds, crmIndex, start, end);
  // Сначала аддитивно сливаем источники, затем канонизируем коды по ИМЕНИ
  // относительно crm_doctors — это приводит числовые/fallback-коды DocSales
  // к стабильному CRM doctor_code (например 673 → 510) и устраняет дубли.
  const merged = mergeDocSalesAggregates(visitsAgg, doctorSalesAgg);
  const agg = canonicalizeDocSalesAggregates(merged, crmIndex);

  // Одна строка на врача×день (period_start=period_end=sale_date=day),
  // чтобы фронт мог суммировать произвольный диапазон дат.
  const rows = [...agg.values()].map((a) => ({
    doctor_code: a.code,
    doctor_name: a.name,
    period_start: a.day,
    period_end: a.day,
    sale_date: a.day,
    amount: Number(a.amount.toFixed(2)),
    checks_count: a.checks.size,
    raw: {
      source: 'docsales',
      source_tables: [...a.sources],
      granularity: 'day',
      ...(a.unmatched && a.unmatched.size
        ? { doctor_code_matched: false, doctor_sales_names: [...a.unmatched] }
        : {}),
    },
    synced_at: new Date().toISOString(),
  }));

  if (rows.length) {
    await crm.upsert('crm_docsales_sales_cache', rows, 'doctor_code,period_start,period_end');
  }
  log(`=== DocSales: готово (врачей ${rows.length}, источники visits + doctor_sales) ===`);
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
  const perSource = {};

  if (source === 'all' || source === '1c') {
    try {
      const n = await syncOneC(crm, start, end);
      perSource['1c'] = n;
      rowsWritten += n;
    } catch (e) {
      errors.push(`1С: ${e.message}`);
      warn(`Источник 1С завершился с ошибкой: ${e.message}`);
    }
  }

  if (source === 'all' || source === 'docsales') {
    try {
      const n = await syncDocSales(crm, start, end);
      perSource.docsales = n;
      rowsWritten += n;
    } catch (e) {
      errors.push(`DocSales: ${e.message}`);
      warn(`Источник DocSales завершился с ошибкой: ${e.message}`);
    }
  }

  const status = errors.length === 0 ? 'ok' : 'partial';
  await finishRun(crm, runId, status, rowsWritten, errors.join(' | '));

  // Явно логируем, что именно записано по каждому источнику — чтобы partial
  // не выглядел как «ничего не записано»: успешные источники уже в CRM и видны
  // во фронте, даже если другой источник упал.
  const written = Object.entries(perSource)
    .map(([s, n]) => `${s}=${n}`)
    .join(', ') || 'нет';
  log(`Готово. Статус=${status}, записано строк=${rowsWritten} (по источникам: ${written}).`);
  if (errors.length) {
    warn(`Завершено с ошибками источников (успешные источники уже сохранены в CRM):\n - ${errors.join('\n - ')}`);
    // Exit code 2 сигнализирует Action о partial-результате (чтобы запуск был
    // помечен как неуспешный и попал в уведомления), но это НЕ откатывает уже
    // записанные строки успешных источников — они остаются видны во фронте.
    process.exit(2);
  }
}

main().catch((e) => {
  fail(`Непредвиденная ошибка: ${e && e.stack ? e.stack : e}`);
});
