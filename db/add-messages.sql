-- =====================================================================
--  הודעות יוצאות מקושרות למשימה (גרסה 2.2)
--  להריץ פעם אחת ב-Supabase → SQL Editor.
--
--  עיקרון: שום הודעה לא יוצאת בלי אישור אנושי מפורש, פר-הודעה.
--  שתיקה לעולם אינה אישור — הודעה שלא אושרה פגה וחוזרת לטיוטה.
-- =====================================================================

create table if not exists pa_messages (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references pa_tasks(id) on delete cascade,

  to_phone     text not null,              -- מספר קנוני, 9725...
  to_name      text,                       -- השם כפי שמופיע באנשי הקשר

  body         text not null,              -- הטקסט המדויק שיישלח

  status       text not null default 'draft'
               check (status in ('draft','scheduled','awaiting_approval','sent','cancelled','expired','failed')),
  send_at      timestamptz,                -- null = ידני בלבד

  created_by   uuid references pa_users(id) on delete set null,
  approved_by  uuid references pa_users(id) on delete set null,
  approved_at  timestamptz,
  asked_at     timestamptz,                -- מתי הוצגה לאישור (לחישוב פקיעה)
  sent_at      timestamptz,
  last_error   text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists pa_messages_task_idx   on pa_messages (task_id);
create index if not exists pa_messages_status_idx on pa_messages (status, send_at);

alter table pa_messages enable row level security;   -- רק ה-worker ניגש

drop trigger if exists pa_messages_touch on pa_messages;
create trigger pa_messages_touch before update on pa_messages
  for each row execute function pa_touch_updated_at();

-- ── יומן שליחות: מה יצא, למי, מתי, ומי אישר ────────────────────────
create table if not exists pa_sent_log (
  id         bigserial primary key,
  message_id uuid,
  to_phone   text not null,
  to_name    text,
  body       text not null,
  approved_by uuid references pa_users(id) on delete set null,
  sent_at    timestamptz not null default now(),
  day        date not null default (now() at time zone 'Asia/Jerusalem')::date
);

create index if not exists pa_sent_log_day_idx on pa_sent_log (day);
alter table pa_sent_log enable row level security;

-- ── מעקות בטיחות (ניתנים לכוונון, לא לכיבוי) ───────────────────────
insert into pa_settings (key, value) values
  ('outbound_daily_cap',      '20'::jsonb),   -- תקרת הודעות יוצאות ליום
  ('outbound_expiry_hours',   '6'::jsonb),    -- כמה זמן ממתינה לאישור
  ('outbound_dedupe_minutes', '10'::jsonb)    -- לא לאותו מספר פעמיים
on conflict (key) do nothing;
