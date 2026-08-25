-- =====================================================================
--  רשימות ייחוס (גרסה 2.3) — מסעדות, ספרים, סרטים, מה שתרצה.
--  להריץ פעם אחת ב-Supabase → SQL Editor.
--
--  אלה *לא* משימות: אין להן תאריך יעד, הן לא נסגרות, והן לעולם
--  לא מופיעות בסיכום הבוקר או ברשימת המשימות. ניגשים אליהן רק
--  כשמבקשים. לכן הן טבלה נפרדת ולא "משימה עם דגל מוסתר" —
--  ככה אי אפשר לשכוח לסנן אותן במקום כלשהו.
-- =====================================================================

create table if not exists pa_lists (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,                  -- "מסעדות ובתי קפה"
  aliases    text[] not null default '{}',   -- איך עוד קוראים לה בשיחה
  icon       text default '📋',
  owner_id   uuid references pa_users(id) on delete set null,
  shared     boolean not null default true,  -- רשימות כאלה טבעי שיהיו לשניכם
  created_at timestamptz not null default now()
);

create table if not exists pa_list_items (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references pa_lists(id) on delete cascade,
  title         text not null,               -- שם המקום / הספר / הסרט
  location_text text,                        -- כפי שנאמר: "פלורנטין תל אביב"
  area          text,                        -- מנורמל לסינון: "תל אביב"
  tags          text[] not null default '{}',
  note          text,
  added_by      uuid references pa_users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists pa_list_items_list_idx on pa_list_items (list_id, created_at);
create index if not exists pa_list_items_area_idx on pa_list_items (area);

-- מספרי קיצור לפריטי רשימה — נפרדים לגמרי ממספרי המשימות,
-- כדי ש-"1" ימשיך תמיד לסמן משימה ולא ייווצר בלבול.
create table if not exists pa_item_refs (
  user_id    uuid not null references pa_users(id) on delete cascade,
  n          int not null,
  item_id    uuid not null references pa_list_items(id) on delete cascade,
  list_id    uuid references pa_lists(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, n)
);

alter table pa_lists      enable row level security;
alter table pa_list_items enable row level security;
alter table pa_item_refs  enable row level security;

-- הרשימה הראשונה, מוכנה לשימוש
insert into pa_lists (name, aliases, icon, shared)
select 'מסעדות ובתי קפה',
       array['מסעדות','מסעדה','בתי קפה','בית קפה','קפה','אוכל','מקומות','מסעדות ובתי קפה'],
       '🍽️', true
where not exists (select 1 from pa_lists where name = 'מסעדות ובתי קפה');
