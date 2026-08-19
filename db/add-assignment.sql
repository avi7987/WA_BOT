-- =====================================================================
--  שיוך משימות בתוך האזור המשותף (גרסה 2)
--  להריץ פעם אחת ב-Supabase → SQL Editor.
--
--  המודל: שלושה אזורים — אישי-אבי, אישי-איה, ומשותף.
--  שיוך הוא תווית בתוך המשותף בלבד ("בטיפול איה"), לא אזור נפרד.
--  אף אחד לא יכול לכתוב לאזור האישי של השני — זה נאכף בשאילתות.
-- =====================================================================

-- מי מטפל במשימה. רלוונטי רק כאשר shared = true.
alter table pa_tasks add column if not exists assigned_to uuid references pa_users(id) on delete set null;

-- מי נגע במשימה אחרון (לחיווי "כבר סומנה ע"י ...")
alter table pa_tasks add column if not exists last_updated_by uuid references pa_users(id) on delete set null;

-- מתי שויכה, כדי לדעת אם כבר הודענו למקבל
alter table pa_tasks add column if not exists assigned_at timestamptz;
alter table pa_tasks add column if not exists assign_notified_at timestamptz;

create index if not exists pa_tasks_assigned_idx on pa_tasks (assigned_to, status);

-- כלל היושרה: משימה משויכת חייבת להיות משותפת.
-- (שיוך משמעו "שנינו רואים, אחד מטפל" — אין שיוך בתוך אזור אישי.)
alter table pa_tasks drop constraint if exists pa_tasks_assign_requires_shared;
alter table pa_tasks add constraint pa_tasks_assign_requires_shared
  check (assigned_to is null or shared = true);

-- איה מקבלת אזור אישי משלה, סימטרי לאבי.
-- (עד כה היא ראתה רק את המשותף וכל מה שהוסיפה נכנס לשם אוטומטית.)
update pa_users set sees_own_tasks = true, default_shared = false where session_key = 'partner';
