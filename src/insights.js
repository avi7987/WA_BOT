// =====================================================================
//  insights.js — "מה לא מסתדר כאן": כפילויות, התנגשויות שעות,
//  משימות שנתקעו, וימים עמוסים מדי. רץ על הרשימה לפני שליחת הסיכום.
// =====================================================================
import { similarity, daysFromToday, fmtTime, fmtDayName } from './util.js';

const DUP = 0.72;

/**
 * tasks — המשימות הפתוחות של המשתמש
 * refIndex — Map מזהה-משימה → המספר שמוצג ברשימה
 * מחזיר מערך משפטים בעברית (עד 5).
 */
export function findIssues(tasks, refIndex = new Map(), now = new Date()) {
  const out = [];
  const num = (t) => (refIndex.has(t.id) ? `(${refIndex.get(t.id)})` : '');

  // ── 1. כפילויות ── (השוואה זוגית — מוגבלת כדי לא להכביד על רשימות ענק)
  const seenPairs = new Set();
  const scan = tasks.slice(0, 80);
  for (let i = 0; i < scan.length; i++) {
    for (let j = i + 1; j < scan.length; j++) {
      const a = scan[i], b = scan[j];
      const key = a.id + b.id;
      if (seenPairs.has(key)) continue;
      if (similarity(a.title, b.title) >= DUP) {
        seenPairs.add(key);
        out.push(`נראה שיש כפילות: "${a.title}" ${num(a)} ו-"${b.title}" ${num(b)}.`);
      }
    }
  }

  // ── 2. התנגשות שעות באותו יום ──
  const timed = tasks.filter((t) => t.due_at && !t.all_day)
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  for (let i = 1; i < timed.length; i++) {
    const a = new Date(timed[i - 1].due_at), b = new Date(timed[i].due_at);
    if (daysFromToday(a, now) !== daysFromToday(b, now)) continue;
    if (Math.abs(b - a) <= 60 * 60e3) {
      out.push(`"${timed[i - 1].title}" ו-"${timed[i].title}" קבועות כמעט לאותה שעה (${fmtTime(a)} ו-${fmtTime(b)}, יום ${fmtDayName(a)}).`);
    }
  }

  // ── 3. משימות שנתקעו הרבה זמן ──
  const stuck = tasks.filter((t) => t.due_at && daysFromToday(new Date(t.due_at), now) <= -14);
  if (stuck.length === 1) {
    out.push(`"${stuck[0].title}" ${num(stuck[0])} באיחור של שבועיים ומעלה — עדיין רלוונטית?`);
  } else if (stuck.length > 1) {
    out.push(`${stuck.length} משימות באיחור של שבועיים ומעלה — אולי הגיע הזמן למחוק חלק.`);
  }

  // ── 4. יום עמוס ──
  const byDay = new Map();
  for (const t of tasks) {
    if (!t.due_at) continue;
    const n = daysFromToday(new Date(t.due_at), now);
    if (n < 0 || n > 7) continue;
    byDay.set(n, (byDay.get(n) || 0) + 1);
  }
  for (const [n, count] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (count >= 7) {
      const when = n === 0 ? 'היום' : n === 1 ? 'מחר' : `יום ${fmtDayName(new Date(Date.now() + n * 864e5))}`;
      out.push(`${when} יש ${count} משימות — כנראה יותר מדי ליום אחד.`);
      break;
    }
  }

  // ── 5. ערימת "מתישהו" ──
  const someday = tasks.filter((t) => !t.due_at);
  if (someday.length >= 8) {
    out.push(`${someday.length} משימות בלי תאריך יעד. שווה לקבוע תאריך לפחות לכמה מהן, אחרת הן לא יקרו.`);
  }

  return out.slice(0, 5);
}

// שורת "מבט על" קצרה לסיכום הבוקר
export function summaryLine(b) {
  const bits = [];
  if (b.overdue.length) bits.push(`${b.overdue.length} באיחור`);
  if (b.today.length) bits.push(`${b.today.length} להיום`);
  const ahead = b.tomorrow.length + b.week.length;
  if (ahead) bits.push(`${ahead} בהמשך השבוע`);
  if (!bits.length) return 'הכל נקי — אין משימות פתוחות להיום 🎉';
  return bits.join(' · ');
}
