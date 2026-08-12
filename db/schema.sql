-- =====================================================================
--  המנהל האישי — מבנה בסיס הנתונים
--  להריץ פעם אחת ב-Supabase → SQL Editor → New query → Run.
--
--  כל הטבלאות מתחילות ב-pa_ (Personal Assistant) כדי שלא יתנגשו
--  בשום פרויקט אחר שיושב על אותו Supabase.
--
--  אבטחה: RLS מופעל על כל הטבלאות ובלי אף מדיניות גישה —
--  כלומר רק ה-worker (עם service_role key) יכול לגעת בנתונים.
--  אין דרך להגיע אליהם מהדפדפן.
-- =====================================================================

create extension if not exists pgcrypto;

-- ── אנשים ───────────────────────────────────────────────────────────
create table if not exists pa_users (
  id             uuid primary key default gen_random_uuid(),
  session_key    text unique not null,              -- 'owner' | 'partner'
  phone          text unique,                       -- מזוהה אוטומטית מהוואטסאפ
  name           text not null,
  role           text not null default 'member' check (role in ('owner','member')),
  digest_time    text not null default '08:00',     -- שעת סיכום הבוקר
  evening_digest boolean not null default false,
  default_shared boolean not null default false,    -- משימה חדשה נחשבת משותפת כברירת מחדל
  sees_own_tasks boolean not null default true,     -- false = רואה רק את הרשימה המשותפת
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ── משימות ──────────────────────────────────────────────────────────
create table if not exists pa_tasks (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  notes          text,
  due_at         timestamptz,                       -- null = "מתישהו", בלי תאריך יעד
  all_day        boolean not null default true,     -- false = נקבעה שעה מדויקת
  status         text not null default 'open' check (status in ('open','done','cancelled')),
  shared         boolean not null default false,    -- מופיע גם אצל בן/בת הזוג
  created_by     uuid references pa_users(id) on delete set null,
  owner_id       uuid references pa_users(id) on delete set null,
  done_by        uuid references pa_users(id) on delete set null,
  done_at        timestamptz,
  recurrence     text,                              -- daily | weekly | monthly | yearly | null
  remind_sent_at timestamptz,                       -- תזכורת בשעת היעד נשלחה
  source_text    text,                              -- מה בדיוק נכתב/הוקלט במקור
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists pa_tasks_open_idx  on pa_tasks (status, due_at);
create index if not exists pa_tasks_owner_idx on pa_tasks (owner_id, status);

-- ── מספרי הקיצור שהוצגו לכל אחד ברשימה האחרונה ──────────────────────
--    (כדי שאפשר יהיה לענות "1,3" ולסמן בוצע)
create table if not exists pa_refs (
  user_id    uuid not null references pa_users(id) on delete cascade,
  n          int  not null,
  task_id    uuid not null references pa_tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, n)
);

-- ── מצב שיחה: שאלת אישור פתוחה + "בטל" לפעולה האחרונה ───────────────
create table if not exists pa_state (
  user_id     uuid primary key references pa_users(id) on delete cascade,
  pending     jsonb,        -- {kind, payload, expires_at}
  last_action jsonb,        -- {kind, task_ids, before} — לביטול
  updated_at  timestamptz not null default now()
);

-- ── יומן שליחות יזומות (כדי לא לשלוח סיכום בוקר פעמיים) ─────────────
create table if not exists pa_log (
  id       bigserial primary key,
  user_id  uuid references pa_users(id) on delete cascade,
  kind     text not null,          -- digest_morning | digest_evening | reminder
  day      date not null default (now() at time zone 'Asia/Jerusalem')::date,
  meta     jsonb,
  sent_at  timestamptz not null default now()
);

create unique index if not exists pa_log_once_idx on pa_log (user_id, kind, day);

-- ── הגדרות כלליות (ניתנות לשינוי מתוך הוואטסאפ) ─────────────────────
create table if not exists pa_settings (
  key   text primary key,
  value jsonb
);

-- ── נעילה: רק ה-worker (service_role) ניגש. הדפדפן חסום לחלוטין. ────
alter table pa_users    enable row level security;
alter table pa_tasks    enable row level security;
alter table pa_refs     enable row level security;
alter table pa_state    enable row level security;
alter table pa_log      enable row level security;
alter table pa_settings enable row level security;

-- ── עדכון אוטומטי של updated_at ─────────────────────────────────────
create or replace function pa_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists pa_tasks_touch on pa_tasks;
create trigger pa_tasks_touch before update on pa_tasks
  for each row execute function pa_touch_updated_at();
