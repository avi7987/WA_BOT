// =====================================================================
//  tasks.js — הלוגיקה של המשימות: הוספה חכמה, סימון בוצע, דחייה,
//  חזרתיות, וזיהוי כפילויות/התנגשויות ברגע ההוספה.
// =====================================================================
import * as db from './db.js';
import { similarity, addDays, addMonths, daysFromToday, ilParts, makeIL, fmtTime } from './util.js';

const SIMILAR_THRESHOLD = 0.72;
// אם שתי המשימות הכי דומות קרובות זו לזו יותר מהפער הזה — לא מנחשים, שואלים
const AMBIGUITY_GAP = 0.12;

// ── הוספה ───────────────────────────────────────────────────────────
/**
 * spec: { title, due_at (ISO|null), all_day, shared, recurrence, notes, source_text }
 * מחזיר { task, warnings[] }  או  { duplicate, warnings[] } כשצריך אישור.
 */
export async function addTask(user, spec, opts = {}) {
  const title = String(spec.title || '').trim();
  if (!title) return { error: 'לא הצלחתי להבין מה המשימה' };

  const open = await db.openTasksFor(user);
  const warnings = [];

  // 1) כפילות — משימה פתוחה עם משמעות כמעט זהה
  if (!opts.force) {
    const dup = findSimilar(open, title);
    if (dup) return { duplicate: dup, spec, warnings };
  }

  // 2) תאריך שכבר עבר
  if (spec.due_at) {
    const d = new Date(spec.due_at);
    const n = daysFromToday(d);
    if (n < 0) warnings.push(`התאריך שנתת (${d.toLocaleDateString('he-IL')}) כבר עבר — שמרתי אותו כמו שהוא, תקן אם צריך.`);
  }

  // 3) התנגשות שעות באותו יום
  if (spec.due_at && spec.all_day === false) {
    const clash = findTimeClash(open, new Date(spec.due_at));
    if (clash) warnings.push(`יש לך כבר "${clash.title}" ב-${fmtTime(new Date(clash.due_at))} באותו יום.`);
  }

  // 4) יום עמוס
  if (spec.due_at) {
    const sameDay = open.filter((t) => t.due_at && daysFromToday(new Date(t.due_at)) === daysFromToday(new Date(spec.due_at)));
    if (sameDay.length >= 6) warnings.push(`זה כבר ${sameDay.length + 1} משימות לאותו יום — שווה לפזר.`);
  }

  // שיוך קיים רק בתוך האזור המשותף — משימה משויכת היא תמיד משותפת.
  const assignedTo = spec.assigned_to || null;
  const shared = !!spec.shared || !!assignedTo;

  const task = await db.insertTask({
    title,
    notes: spec.notes || null,
    due_at: spec.due_at || null,
    all_day: spec.all_day !== false,
    shared,
    assigned_to: assignedTo,
    assigned_at: assignedTo ? new Date().toISOString() : null,
    recurrence: spec.recurrence || null,
    created_by: user.id,
    owner_id: user.id,
    last_updated_by: user.id,
    source_text: spec.source_text || null,
  });

  await db.setState(user.id, { last_action: { kind: 'add', task_ids: [task.id] }, pending: null });
  return { task, warnings };
}

export function findSimilar(tasks, title) {
  let best = null, bestScore = 0;
  for (const t of tasks) {
    const s = similarity(t.title, title);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return bestScore >= SIMILAR_THRESHOLD ? best : null;
}

function findTimeClash(tasks, when) {
  const day = daysFromToday(when);
  for (const t of tasks) {
    if (!t.due_at || t.all_day) continue;
    const d = new Date(t.due_at);
    if (daysFromToday(d) !== day) continue;
    if (Math.abs(d.getTime() - when.getTime()) <= 60 * 60e3) return t;
  }
  return null;
}

// ── סימון בוצע ──────────────────────────────────────────────────────
export async function completeTasks(user, taskIds) {
  const done = [], repeated = [], already = [];
  for (const id of taskIds) {
    const t = await db.getTask(id);
    if (!t) continue;
    // מישהו הקדים אותך — עדיף לומר מי ומתי מאשר "לא מצאתי"
    if (t.status !== 'open') { if (t.status === 'done') already.push(t); continue; }
    await db.updateTask(id, { status: 'done', done_at: new Date().toISOString(), done_by: user.id, last_updated_by: user.id });
    done.push(t);
    if (t.recurrence) {
      const next = nextOccurrence(t);
      if (next) {
        const clone = await db.insertTask({
          title: t.title, notes: t.notes, due_at: next.toISOString(), all_day: t.all_day,
          shared: t.shared, recurrence: t.recurrence, created_by: t.created_by,
          owner_id: t.owner_id, source_text: t.source_text,
        });
        repeated.push(clone);
      }
    }
  }
  if (done.length) await db.setState(user.id, { last_action: { kind: 'complete', task_ids: done.map((t) => t.id) } });
  return { done, repeated, already };
}

// ── שיוך בתוך האזור המשותף ──────────────────────────────────────────
export async function setAssignee(user, taskIds, assigneeId) {
  const changed = [];
  for (const id of taskIds) {
    const before = await db.getTask(id);
    if (!before || before.status !== 'open') continue;
    const t = await db.updateTask(id, {
      assigned_to: assigneeId,
      assigned_at: assigneeId ? new Date().toISOString() : null,
      assign_notified_at: null,
      shared: true,               // שיוך גורר שיתוף — אין שיוך באזור אישי
      last_updated_by: user.id,
    });
    if (t) changed.push({ task: t, before: before.assigned_to });
  }
  if (changed.length) {
    await db.setState(user.id, {
      last_action: { kind: 'assign', task_ids: changed.map((c) => c.task.id), before: changed.map((c) => c.before) },
    });
  }
  return changed;
}

export function nextOccurrence(task) {
  if (!task.recurrence) return null;
  let d = task.due_at ? new Date(task.due_at) : new Date();
  const step = (x) => {
    switch (task.recurrence) {
      case 'daily': return addDays(x, 1);
      case 'weekly': return addDays(x, 7);
      case 'monthly': return addMonths(x, 1);
      case 'yearly': return addMonths(x, 12);
      default: return null;
    }
  };
  for (let i = 0; i < 400; i++) {
    const n = step(d);
    if (!n) return null;
    d = n;
    if (d.getTime() > Date.now()) return d;
  }
  return d;
}

// ── דחייה ───────────────────────────────────────────────────────────
export async function snoozeTasks(user, taskIds, due, allDay = true) {
  const moved = [];
  for (const id of taskIds) {
    const before = await db.getTask(id);
    if (!before || before.status !== 'open') continue;
    const t = await db.updateTask(id, { due_at: due.toISOString(), all_day: allDay, remind_sent_at: null });
    if (t) moved.push({ task: t, prevDue: before.due_at });
  }
  if (moved.length) {
    await db.setState(user.id, {
      last_action: { kind: 'snooze', task_ids: moved.map((m) => m.task.id), before: moved.map((m) => m.prevDue) },
    });
  }
  return moved;
}

// ── מחיקה ───────────────────────────────────────────────────────────
export async function deleteTasks(user, taskIds) {
  const removed = [];
  for (const id of taskIds) {
    const t = await db.getTask(id);
    if (!t || t.status !== 'open') continue;
    await db.updateTask(id, { status: 'cancelled' });
    removed.push(t);
  }
  if (removed.length) await db.setState(user.id, { last_action: { kind: 'delete', task_ids: removed.map((t) => t.id) } });
  return removed;
}

// ── שיתוף ───────────────────────────────────────────────────────────
export async function setShared(user, taskIds, shared) {
  const changed = [];
  for (const id of taskIds) {
    const t = await db.updateTask(id, { shared: !!shared });
    if (t) changed.push(t);
  }
  if (changed.length) await db.setState(user.id, { last_action: { kind: 'share', task_ids: changed.map((t) => t.id), before: !shared } });
  return changed;
}

// ── ביטול הפעולה האחרונה ────────────────────────────────────────────
export async function undoLast(user) {
  const st = await db.getState(user.id);
  const la = st.last_action;
  if (!la || !la.task_ids?.length) return null;

  switch (la.kind) {
    case 'add':
    case 'delete': {
      const status = la.kind === 'add' ? 'cancelled' : 'open';
      for (const id of la.task_ids) await db.updateTask(id, { status });
      break;
    }
    case 'complete':
      for (const id of la.task_ids) await db.updateTask(id, { status: 'open', done_at: null, done_by: null });
      break;
    case 'snooze':
      for (let i = 0; i < la.task_ids.length; i++) {
        await db.updateTask(la.task_ids[i], { due_at: la.before?.[i] ?? null });
      }
      break;
    case 'share':
      for (const id of la.task_ids) await db.updateTask(id, { shared: !!la.before });
      break;
    case 'assign':
      for (let i = 0; i < la.task_ids.length; i++) {
        await db.updateTask(la.task_ids[i], { assigned_to: la.before?.[i] ?? null });
      }
      break;
    default:
      return null;
  }
  await db.setState(user.id, { last_action: null });
  return la;
}

// ── פענוח הפניות ("1,3" או שם משימה) ────────────────────────────────
export async function resolveRefs(user, refs) {
  const ids = [];
  const missing = [];
  const ambiguous = [];
  const open = await db.openTasksFor(user);
  for (const r of refs) {
    if (typeof r === 'number' || /^\d+$/.test(String(r))) {
      const id = await db.resolveRef(user.id, parseInt(r, 10));
      if (id) ids.push(id); else missing.push(r);
    } else {
      const cands = findCandidates(open, String(r));
      if (!cands.length) { missing.push(r); continue; }
      // שתי משימות קרובות באותה מידה — עדיף לשאול מאשר לנחש
      if (cands.length > 1 && cands[1].score >= SIMILAR_THRESHOLD && cands[0].score - cands[1].score < AMBIGUITY_GAP) {
        ambiguous.push({ query: String(r), candidates: cands.filter((c) => c.score >= SIMILAR_THRESHOLD).slice(0, 4).map((c) => c.task) });
        continue;
      }
      ids.push(cands[0].task.id);
    }
  }
  return { ids: [...new Set(ids)], missing, ambiguous };
}

// כל ההתאמות מעל הסף, מהטובה לפחות טובה
export function findCandidates(tasks, title) {
  return tasks
    .map((t) => ({ task: t, score: similarity(t.title, title) }))
    .filter((c) => c.score >= SIMILAR_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

// ── פילוח לרשימות ───────────────────────────────────────────────────
export function bucket(tasks, now = new Date()) {
  const overdue = [], today = [], tomorrow = [], week = [], later = [], someday = [];
  for (const t of tasks) {
    if (!t.due_at) { someday.push(t); continue; }
    const n = daysFromToday(new Date(t.due_at), now);
    if (n < 0) overdue.push(t);
    else if (n === 0) today.push(t);
    else if (n === 1) tomorrow.push(t);
    else if (n <= 7) week.push(t);
    else later.push(t);
  }
  const byDue = (a, b) => new Date(a.due_at) - new Date(b.due_at);
  return {
    overdue: overdue.sort(byDue), today: today.sort(byDue), tomorrow: tomorrow.sort(byDue),
    week: week.sort(byDue), later: later.sort(byDue), someday,
  };
}

// תאריך "מחר בבוקר" וכדומה עבור דחייה מהירה
export function tomorrowMorning(now = new Date()) {
  const d = addDays(now, 1);
  const p = ilParts(d);
  return makeIL(p.y, p.m, p.d, 9, 0);
}
