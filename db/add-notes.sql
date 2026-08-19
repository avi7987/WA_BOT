-- =====================================================================
--  הערות על משימות + תזכורת מקדימה (גרסה 2.1)
--  להריץ פעם אחת ב-Supabase → SQL Editor.
-- =====================================================================

create table if not exists pa_notes (
  id         bigserial primary key,
  task_id    uuid not null references pa_tasks(id) on delete cascade,
  author_id  uuid references pa_users(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists pa_notes_task_idx on pa_notes (task_id, created_at);

alter table pa_notes enable row level security;   -- רק ה-worker ניגש

-- כמה דקות לפני מועד היעד לשלוח תזכורת (0 = בדיוק בזמן)
insert into pa_settings (key, value) values ('remind_lead_minutes', '15'::jsonb)
  on conflict (key) do nothing;

-- תזכורת מקדימה נשלחה (בנפרד מהתזכורת בזמן עצמו)
alter table pa_tasks add column if not exists remind_lead_sent_at timestamptz;
