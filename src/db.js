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

// ── הודעות יוצאות ───────────────────────────────────────────────────
export async function createMessage(msg) {
  const { data, error } = await supabase.from('pa_messages').insert(msg).select().single();
  if (error) throw error;
  return data;
}

export async function updateMessage(id, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const { data } = await supabase.from('pa_messages').update(clean).eq('id', id).select().maybeSingle();
  return data || null;
}

export async function getMessage(id) {
  const { data } = await supabase.from('pa_messages').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// ההודעות הפעילות של משימה (טיוטה/מתוזמנת/ממתינה) — לא היסטוריה
const LIVE = ['draft', 'scheduled', 'awaiting_approval'];

export async function messagesForTask(taskId) {
  const { data } = await supabase.from('pa_messages')
    .select('*').eq('task_id', taskId).in('status', LIVE).order('created_at');
  return data || [];
}

// כמה הודעות פעילות יש לכל משימה ברשימה — לסימון 📤
export async function messageCounts(taskIds) {
  const counts = new Map();
  if (!taskIds.length) return counts;
  const { data } = await supabase.from('pa_messages')
    .select('task_id').in('task_id', taskIds).in('status', LIVE);
  for (const r of (data || [])) counts.set(r.task_id, (counts.get(r.task_id) || 0) + 1);
  return counts;
}

export async function liveMessages() {
  const { data } = await supabase.from('pa_messages').select('*').in('status', LIVE).limit(200);
  return data || [];
}

export async function messagesAwaiting(userId) {
  const { data } = await supabase.from('pa_messages')
    .select('*').eq('status', 'awaiting_approval').eq('created_by', userId).order('asked_at');
  return data || [];
}

// ── יומן שליחות ומעקות ──────────────────────────────────────────────
export async function logSent(row) {
  await supabase.from('pa_sent_log').insert(row);
}

export async function sentTodayCount() {
  return (await sentToday()).length;
}

// האם נשלחה הודעה לאותו מספר בדקות האחרונות (הגנה מכפילות)
export async function sentRecentlyTo(phone, minutes) {
  const since = new Date(Date.now() - minutes * 60e3).toISOString();
  const { data } = await supabase.from('pa_sent_log')
    .select('sent_at').eq('to_phone', phone).gte('sent_at', since).limit(1);
  return (data || []).length > 0;
}

export async function sentToday() {
  const { data } = await supabase.from('pa_sent_log')
    .select('*').eq('day', ilDateStr()).order('sent_at');
  return data || [];
}

// ── זימונים ביומן ───────────────────────────────────────────────────
export async function createCalendarEvent(row) {
  const { data, error } = await supabase.from('pa_events').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function updateCalendarEvent(id, fields) {
  const { data } = await supabase.from('pa_events').update(fields).eq('id', id).select().maybeSingle();
  return data || null;
}

// הזימונים החיים של משתמש, החדשים קודם
export async function liveCalendarEvents(userId, limit = 20) {
  const { data } = await supabase.from('pa_events')
    .select('*').eq('created_by', userId).neq('status', 'cancelled')
    .order('created_at', { ascending: false }).limit(limit);
  return data || [];
}

export async function eventsForTasks(taskIds) {
  const counts = new Map();
  if (!taskIds.length) return counts;
  const { data } = await supabase.from('pa_events')
    .select('task_id').in('task_id', taskIds).neq('status', 'cancelled');
  for (const r of (data || [])) if (r.task_id) counts.set(r.task_id, (counts.get(r.task_id) || 0) + 1);
  return counts;
}

// ── תיבת רעיונות (שיפורים לבוט עצמו) ────────────────────────────────
export async function createRequest(row) {
  const { data, error } = await supabase.from('pa_requests').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function openRequests() {
  const { data } = await supabase.from('pa_requests')
    .select('*').in('status', ['new', 'planned']).order('created_at');
  return data || [];
}

export async function allRequests() {
  const { data } = await supabase.from('pa_requests').select('*').order('created_at');
  return data || [];
}

export async function updateRequest(id, fields) {
  const { data } = await supabase.from('pa_requests').update(fields).eq('id', id).select().maybeSingle();
  return data || null;
}

// מספרי קיצור לרעיונות — שוב מרחב נפרד, כדי ש-"1" יישאר משימה
export async function setRequestRefs(userId, ids) {
  await supabase.from('pa_req_refs').delete().eq('user_id', userId);
  if (!ids.length) return;
  await supabase.from('pa_req_refs').insert(ids.map((request_id, i) => ({ user_id: userId, n: i + 1, request_id })));
}

export async function resolveRequestRef(userId, n) {
  const { data } = await supabase.from('pa_req_refs')
    .select('request_id').eq('user_id', userId).eq('n', n).maybeSingle();
  return data?.request_id || null;
}

// ── רשימות ייחוס (מסעדות, ספרים...) ─────────────────────────────────
export async function getLists() {
  const { data } = await supabase.from('pa_lists').select('*').order('created_at');
  return data || [];
}

export async function createList(row) {
  const { data, error } = await supabase.from('pa_lists').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function listItems(listId) {
  const { data } = await supabase.from('pa_list_items')
    .select('*').eq('list_id', listId).order('created_at');
  return data || [];
}

export async function createListItem(row) {
  const { data, error } = await supabase.from('pa_list_items').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function deleteListItem(id) {
  const { data } = await supabase.from('pa_list_items').delete().eq('id', id).select().maybeSingle();
  return data || null;
}

// מספרי קיצור לפריטי רשימה — מרחב נפרד ממספרי המשימות
export async function setItemRefs(userId, listId, itemIds) {
  await supabase.from('pa_item_refs').delete().eq('user_id', userId);
  if (!itemIds.length) return;
  await supabase.from('pa_item_refs').insert(
    itemIds.map((item_id, i) => ({ user_id: userId, n: i + 1, item_id, list_id: listId })),
  );
}

export async function resolveItemRef(userId, n) {
  const { data } = await supabase.from('pa_item_refs')
    .select('item_id,list_id').eq('user_id', userId).eq('n', n).maybeSingle();
  return data || null;
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
