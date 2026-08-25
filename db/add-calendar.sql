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
