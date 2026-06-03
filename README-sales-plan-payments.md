# CRM ТП — новые вкладки: Продажи / Выплаты / План / Профиль / Админ-статистика

Этот документ описывает добавленные вкладки, схему БД и то, **что осталось подключить**
(синхронизацию данных из 1С и DocSales), а также какие ключи/переменные окружения
для этого нужны.

## Что добавлено

- **`index.html`** — пять новых вкладок (однофайловая архитектура сохранена):
  - 💵 **Продажи** — сверка 1С vs DocSales. Строгий фильтр `period_start` / `period_end`
    + опционально код врача. Колонки: врач, код, продажи 1С, чеки 1С, продажи DocSales,
    разница %, бонус 10%, бонус за пациентов, итого к выплате, статус сверки.
    Разница > 10% подсвечивается. Расчёт: `итого = продажи_1С × 0.10 + чеки_1С × 10`.
    Читает **только** представление `crm_doctor_bonus_periods` (кэш Supabase).
  - 💳 **Выплаты** — фильтр по датам / врачу / ТП; начислено, выплачено, долг, просрочка
    (от конца периода). Создание выплаты (admin и ТП) с полями `amount`, `payment_date`,
    `comment`, привязкой к `doctor_code` и `rep_login`.
  - 🗓 **План** — план визитов на завтра/неделю/месяц (только будни). Статусы
    `planned/visited/missed/carried_over/cancelled`, плановая/фактическая выплата,
    `original_plan_date`. Кнопка «Перенести невыполненные» переносит просроченные
    `planned`-пункты на следующий рабочий день. При сохранении визита плановый пункт
    того же врача за сегодня автоматически закрывается как `visited`; если пункт не найден —
    выплата считается внеплановой (уведомление пользователю).
  - 🧑‍💼 **Профиль ТП** — прогресс визитов за месяц/неделю с остатком от плана, долги/просрочки,
    баллы и журнал баллов. Админ может начислить/списать баллы через ledger.
  - 📈 **Админ-статистика** — по каждому ТП за сегодня/неделю/месяц: визиты, просрочки выплат,
    деньги потрачено, баллы.
- **`sql-sales-plan-payments.sql`** — идемпотентная миграция (таблицы, индексы, `updated_at`,
  триггеры, RLS-политики, view сверки).

Существующие вкладки и авторизация **не изменены** по логике — только добавлены кнопки
навигации и новые секции; механизм показа секций (`openSubSection` / `backToDashboard`)
повторяет существующий паттерн.

## Баллы

- 1 посещённый врач = **+1 балл** (начисляется автоматически при сохранении визита,
  идемпотентно по `visit_id` через unique-индекс).
- «Выплаты вовремя» можно показывать как бонусную метрику (заложено в reason
  `payment_on_time`).
- Админ начисляет/списывает баллы вручную через `crm_rep_points_ledger`.

## Применение миграции

```bash
# через Supabase SQL Editor — вставить содержимое файла, либо psql:
psql "$SUPABASE_DB_URL" -f sql-sales-plan-payments.sql
```

Таблицы создаются с `IF NOT EXISTS`, повторный запуск безопасен.

## Модель доступа (RLS)

Проект сейчас работает через **anon-ключ** без Supabase Auth и разделяет данные
по полю логина внутри строк (`user_login` / `rep_login`). Чтобы не сломать текущее поведение:

- кэш-таблицы 1С/DocSales (`crm_onec_sales_cache`, `crm_docsales_sales_cache`) — **read-only**
  для anon (писать должен только backend-синк с `service_role`);
- операционные таблицы (`crm_doctor_payments`, `crm_rep_plan_items`, `crm_rep_points_ledger`,
  `crm_doctors`) — пока полный доступ anon (в стиле проекта).

В конце миграции есть закомментированный **строгий вариант** политик (ТП видит только своё,
admin — всё) — включить после внедрения настоящей авторизации (JWT с `login`/`role`).

## ⚠️ Что осталось подключить — синхронизация источников

Frontend **не содержит** и **не должен содержать** учётных данных 1С. Полноценная
интеграция требует backend-процесса (Supabase Edge Function / cron / отдельный сервис),
который наполняет кэш-таблицы. Без него вкладки работают, но таблицы сверки будут пусты.

### 1С (OData)

- База: `http://109.61.108.60:3050/retail/ru/odata/standard.odata/`, Basic auth.
- Сущности: `Catalog_ИнформационныеКарты`, `Catalog_ВидыДисконтныхКарт`,
  `AccumulationRegister_ПродажиПоДисконтнымКартам_RecordType`, `Document_ЧекККМ`.
- Константы:
  - Вид дисконтной карты «для учёта»: `Ref_Key = 37292453-0e5b-11ee-879c-d8c0a681cbca`
  - Папка «Врачи» в `Catalog_ИнформационныеКарты`: `Ref_Key = 37292452-0e5b-11ee-879c-d8c0a681cbca`
- Врачебные карты: `Parent_Key == folder` ИЛИ `ВидДисконтнойКарты_Key == kind`;
  поля `Code`, `Description`, `КодКарты`, `Ref_Key` → `crm_doctors`.
- Продажи: `AccumulationRegister_..._RecordType`, поля `Period`, `Recorder`, `Active`,
  `ДисконтнаяКарта_Key`, `Сумма`, `Количество` → агрегировать по врачу+периоду в
  `crm_onec_sales_cache` (`amount`, `checks_count`).
- **Важно:** `$filter` по `Period` / `Description` / `Parent_Key` в этой базе падает —
  фильтрацию выполнять на стороне backend (скачать и отфильтровать в памяти),
  затем UPSERT в кэш по unique-индексу `(doctor_code, period_start, period_end)`.

### DocSales

- Источник: `https://docsales2.vercel.app/app.html`,
  Supabase URL `https://mvjiqysmcclvceswfqwv.supabase.co`.
- Таблицы: `diagnoses, doctors, patients, products, profiles, reports, salons,
  visit_items, visit_photos, visits`.
- Часть таблиц без auth/RLS пустая → нужен доступ с `service_role` целевого проекта
  или RPC; результат складывать в `crm_docsales_sales_cache`.

### Переменные окружения для backend-синка (НЕ во frontend)

```
ONEC_ODATA_URL=http://109.61.108.60:3050/retail/ru/odata/standard.odata/
ONEC_BASIC_USER=<логин 1С>           # держать только на сервере
ONEC_BASIC_PASSWORD=<пароль 1С>      # держать только на сервере
ONEC_DOCTOR_FOLDER_REF=37292452-0e5b-11ee-879c-d8c0a681cbca
ONEC_DISCOUNT_KIND_REF=37292453-0e5b-11ee-879c-d8c0a681cbca

DOCSALES_SUPABASE_URL=https://mvjiqysmcclvceswfqwv.supabase.co
DOCSALES_SERVICE_ROLE_KEY=<service_role ключ DocSales-проекта>

# Целевой проект CRM (куда пишем кэш):
CRM_SUPABASE_URL=https://jyhlrjrrmemttyvicibq.supabase.co
CRM_SERVICE_ROLE_KEY=<service_role ключ CRM-проекта>   # для записи в кэш-таблицы
```

Синк наполняет: `crm_doctors`, `crm_onec_sales_cache`, `crm_docsales_sales_cache`.
View `crm_doctor_bonus_periods` считается автоматически и читается фронтендом.

## Backend-синхронизация

В репозиторий добавлен cron-ready Node-скрипт:

```bash
node scripts/sync-sales.js --start=2026-05-01 --end=2026-05-31
node scripts/sync-sales.js --start=2026-05-01 --end=2026-05-31 --source=1c
node scripts/sync-sales.js --start=2026-05-01 --end=2026-05-31 --source=docsales
```

Скрипт не требует runtime-зависимостей и работает на Node.js 18+. Он читает 1С OData постранично через `$top/$skip`, фильтрует период на стороне Node.js, записывает врачей в `crm_doctors`, продажи 1С в `crm_onec_sales_cache`, продажи DocSales в `crm_docsales_sales_cache`, а статус запуска в `crm_sync_runs`.

Перед запуском создайте `.env` по шаблону `.env.example`. Секреты нельзя коммитить в GitHub и нельзя вставлять в `index.html`.

## Проверка

- JS-синтаксис: извлечён скрипт из `index.html` и проверен `node --check` — OK.
- Баланс `<div>` и наличие всех функций/ID — проверено.
