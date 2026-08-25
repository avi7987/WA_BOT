-- ============================================================
--  שני העדכונים האחרונים: תיבת רעיונות + זימונים ביומן
--  להריץ פעם אחת ב-Supabase → SQL Editor → New query → Run
-- ============================================================

-- =====================================================================
--  תיבת רעיונות (גרסה 2.4)
--  להריץ פעם אחת ב-Supabase → SQL Editor.
--
--  רעיונות לשיפור הבוט עצמו — לא משימות ולא רשימות ייחוס.
--  הם לא מופיעים בסיכום הבוקר ולא ברשימת המשימות, בדיוק כמו
--  הרשימות: ניגשים אליהם רק כשמבקשים.
-- =====================================================================

create table if not exists pa_requests (
  id          uuid primary key default gen_random_uuid(),
  body        text not null,              -- הרעיון כפי שנוסח
  status      text not null default 'new'
              check (status in ('new','planned','done','rejected')),
  source_text text,                       -- מה בדיוק נאמר/הוקלט
  created_by  uuid references pa_users(id) on delete set null,
  reply       text,                       -- תשובה/הערה שנרשמה בטיפול
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists pa_requests_status_idx on pa_requests (status, created_at);

-- מספרי קיצור לרעיונות — מרחב נפרד ממספרי המשימות ומפריטי הרשימות,
-- כדי ש-"1" יישאר תמיד סימון של משימה.
create table if not exists pa_req_refs (
  user_id    uuid not null references pa_users(id) on delete cascade,
  n          int not null,
  request_id uuid not null references pa_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, n)
);

alter table pa_requests enable row level security;   -- רק ה-worker ניגש
alter table pa_req_refs enable row level security;
-- =====================================================================
--  זימונים ביומן גוגל (גרסה 2.5)
--  להריץ פעם אחת ב-Supabase → SQL Editor.
--
--  שומרים את מזהה האירוע שגוגל מחזיר, כדי שאפשר יהיה לבטל או
--  לעדכן אותו אחר כך ("תבטל את הזימון").
-- =====================================================================

create table if not exists pa_events (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid references pa_tasks(id) on delete set null,

  title        text not null,
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  all_day      boolean not null default false,   -- "טנטטיבי ביום ש..." = יום שלם
  location     text,
  description  text,
  guests       text[] not null default '{}',

  google_id    text,                             -- מזהה האירוע אצל גוגל
  html_link    text,                             -- קישור לצפייה ביומן
  status       text not null default 'created'
               check (status in ('created','link_only','cancelled','failed')),
  last_error   text,

  created_by   uuid references pa_users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists pa_events_task_idx  on pa_events (task_id);
create index if not exists pa_events_start_idx on pa_events (starts_at);

alter table pa_events enable row level security;   -- רק ה-worker ניגש

-- כתובות מייל לאורחים קבועים, כדי ש"תוסיף את איה" יעבוד
insert into pa_settings (key, value) values
  ('calendar_guest_aliases', '{"איה":"ayaokshus@gmail.com"}'::jsonb),
  ('calendar_default_duration_min', '60'::jsonb)
on conflict (key) do nothing;
