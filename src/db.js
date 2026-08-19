// =====================================================================
//  db.js — כל הגישה ל-Supabase במקום אחד.
//  ה-worker משתמש ב-service_role key ולכן עוקף RLS (וזה בסדר —
//  הוא רץ בשרת שלנו בלבד, אף פעם לא בדפדפן).
// =====================================================================
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ilDateStr } from './util.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('❌ חסרים SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY בקובץ .env');
  process.exit(1);
}

export let supabase = createClient(url, key, { auth: { persistSession: false } });

// מאפשר לבדיקות להחליף את החיבור בבסיס נתונים בזיכרון.
// (ESM live bindings — כל מי שייבא `supabase` יראה את ההחלפה.)
export function __setClientForTests(client) { supabase = client; }

// ── אנשים ───────────────────────────────────────────────────────────
export async function upsertUser(sessionKey, fields) {
  const { data, error } = await supabase.from('pa_users')
    .upsert({ session_key: sessionKey, ...fields }, { onConflict: 'session_key' })
    .select().single();
  if (error) throw error;
  return data;
}

export async function getUserBySession(sessionKey) {
  const { data } = await supabase.from('pa_users').select('*').eq('session_key', sessionKey).maybeSingle();
  return data || null;
}

export async function listUsers() {
  const { data } = await supabase.from('pa_users').select('*').eq('active', true).order('created_at');
  return data || [];
}

// ── משימות ──────────────────────────────────────────────────────────
export async function insertTask(task) {
  const { data, error } = await supabase.from('pa_tasks').insert(task).select().single();
  if (error) throw error;
  return data;
}

export async function updateTask(id, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (!Object.keys(clean).length) return null;
  const { data, error } = await supabase.from('pa_tasks').update(clean).eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
}

export async function getTask(id) {
  const { data } = await supabase.from('pa_tasks').select('*').eq('id', id).maybeSingle();
  return data || null;
}

/**
 * כל המשימות הפתוחות שרלוונטיות לאדם מסוים:
 *  - מה שהוא יצר (אלא אם הוגדר שהוא רואה רק את המשותף)
 *  - כל מה שמסומן כמשותף
 */
export async function openTasksFor(user) {
  const filters = ['shared.eq.true'];
  if (user.sees_own_tasks !== false) filters.push(`owner_id.eq.${user.id}`);
  const { data, error } = await supabase.from('pa_tasks')
    .select('*')
    .eq('status', 'open')
    .or(filters.join(','))
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(300);
  if (error) throw error;
  return data || [];
}

// כל המשימות הפתוחות במערכת (למתזמן התזכורות)
export async function allOpenTasks() {
  const { data } = await supabase.from('pa_tasks').select('*').eq('status', 'open').limit(500);
  return data || [];
}

export async function recentlyDone(user, days = 7) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data } = await supabase.from('pa_tasks').select('*')
    .eq('status', 'done').gte('done_at', since)
    .or(`owner_id.eq.${user.id},shared.eq.true`)
    .order('done_at', { ascending: false }).limit(50);
  return data || [];
}

// ── הערות על משימות ─────────────────────────────────────────────────
export async function addNote(taskId, authorId, body) {
  const { data, error } = await supabase.from('pa_notes')
    .insert({ task_id: taskId, author_id: authorId, body }).select().single();
  if (error) throw error;
  return data;
}

export async function getNotes(taskId) {
  const { data } = await supabase.from('pa_notes')
    .select('*').eq('task_id', taskId).order('created_at');
  return data || [];
}

// כמה הערות יש לכל משימה ברשימה — שאילתה אחת במקום אחת לכל משימה
export async function noteCounts(taskIds) {
  const counts = new Map();
  if (!taskIds.length) return counts;
  const { data } = await supabase.from('pa_notes').select('task_id').in('task_id', taskIds);
  for (const r of (data || [])) counts.set(r.task_id, (counts.get(r.task_id) || 0) + 1);
  return counts;
}

// ── מספרי קיצור (הרשימה שהוצגה לאחרונה) ─────────────────────────────
export async function setRefs(userId, taskIds) {
  await supabase.from('pa_refs').delete().eq('user_id', userId);
  if (!taskIds.length) return;
  const rows = taskIds.map((task_id, i) => ({ user_id: userId, n: i + 1, task_id }));
  await supabase.from('pa_refs').insert(rows);
}

export async function getRefs(userId) {
  const { data } = await supabase.from('pa_refs')
    .select('n,task_id').eq('user_id', userId).order('n');
  return data || [];
}

export async function resolveRef(userId, n) {
  const { data } = await supabase.from('pa_refs')
    .select('task_id').eq('user_id', userId).eq('n', n).maybeSingle();
  return data?.task_id || null;
}

// ── מצב שיחה (אישור ממתין / ביטול פעולה אחרונה) ─────────────────────
export async function getState(userId) {
  const { data } = await supabase.from('pa_state').select('*').eq('user_id', userId).maybeSingle();
  return data || { user_id: userId, pending: null, last_action: null };
}

export async function setState(userId, fields) {
  await supabase.from('pa_state')
    .upsert({ user_id: userId, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
}

export async function clearPending(userId) {
  await setState(userId, { pending: null });
}

// ── יומן שליחות יזומות ──────────────────────────────────────────────
// מחזיר true אם זו הפעם הראשונה היום (ולכן מותר לשלוח)
export async function claimDaily(userId, kind, meta = null) {
  const { error } = await supabase.from('pa_log')
    .insert({ user_id: userId, kind, day: ilDateStr(), meta });
  if (error) return false;         // כבר נשלח היום (מפתח ייחודי)
  return true;
}

// ── הגדרות ──────────────────────────────────────────────────────────
export async function getSetting(key, fallback = null) {
  const { data } = await supabase.from('pa_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? fallback;
}

export async function setSetting(key, value) {
  await supabase.from('pa_settings').upsert({ key, value }, { onConflict: 'key' });
}
