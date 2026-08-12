// =====================================================================
//  util.js — כלי עזר: זמן בשעון ישראל, טקסט, דמיון בין משימות
//  השרת בענן רץ ב-UTC, ולכן כל חישוב תאריך נעשה במפורש מול Asia/Jerusalem.
// =====================================================================

export const TZ = process.env.TZ_NAME || 'Asia/Jerusalem';

const pad = (n) => String(n).padStart(2, '0');

// ── מרכיבי התאריך בשעון ישראל, מתוך רגע נתון ─────────────────────────
export function ilParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const g = (t) => f.find((p) => p.type === t)?.value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: +g('year'), m: +g('month'), d: +g('day'),
    h: +g('hour') % 24, min: +g('minute'),
    wd: wdMap[g('weekday')] ?? 0,
  };
}

// היסט השעון בישראל ברגע מסוים ("+03:00" בקיץ, "+02:00" בחורף)
function ilOffset(date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).format(date);
  const m = /GMT([+-]\d{2}):?(\d{2})/.exec(s);
  return m ? `${m[1]}:${m[2]}` : '+02:00';
}

// בונה רגע מדויק מתוך תאריך+שעה שנאמרו בשעון ישראל
export function makeIL(y, mo, d, h = 0, mi = 0) {
  const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));   // צהריים — רחוק מקצוות המעבר לשעון קיץ
  const off = ilOffset(probe);
  return new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${off}`);
}

// 'YYYY-MM-DD' בשעון ישראל
export function ilDateStr(date = new Date()) {
  const p = ilParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

// תחילת היום (00:00 בישראל) של תאריך נתון
export function ilStartOfDay(date = new Date()) {
  const p = ilParts(date);
  return makeIL(p.y, p.m, p.d, 0, 0);
}

// הפרש בימי לוח: 0 = היום, 1 = מחר, -1 = אתמול
export function daysFromToday(date, now = new Date()) {
  const a = ilStartOfDay(now).getTime();
  const b = ilStartOfDay(date).getTime();
  return Math.round((b - a) / 864e5);
}

export function addDays(date, n) {
  const p = ilParts(date);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
  base.setUTCDate(base.getUTCDate() + n);
  const q = { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
  return makeIL(q.y, q.m, q.d, p.h, p.min);
}

export function addMonths(date, n) {
  const p = ilParts(date);
  const base = new Date(Date.UTC(p.y, p.m - 1, 1, 12));
  base.setUTCMonth(base.getUTCMonth() + n);
  const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
  return makeIL(y, m, Math.min(p.d, lastDay), p.h, p.min);
}

// דקות מתחילת היום, בשעון ישראל
export function ilMinutesNow(now = new Date()) {
  const p = ilParts(now);
  return p.h * 60 + p.min;
}

export function hhmmToMinutes(hhmm, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? +m[1] * 60 + +m[2] : fallback;
}

// חלון שעות מותר לשליחה יזומה
export function withinQuietWindow(now = new Date()) {
  const cur = ilMinutesNow(now);
  const start = hhmmToMinutes(process.env.QUIET_START, 7 * 60);
  const end = hhmmToMinutes(process.env.QUIET_END, 22 * 60 + 30);
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}

// ── תצוגת תאריכים בעברית ────────────────────────────────────────────
export const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

export function fmtTime(date) {
  const p = ilParts(date);
  return `${pad(p.h)}:${pad(p.min)}`;
}

export function fmtDate(date) {
  const p = ilParts(date);
  return `${p.d}.${p.m}`;
}

export function fmtDayName(date) {
  return HEB_DAYS[ilParts(date).wd];
}

// "היום" / "מחר" / "בעוד 3 ימים" / "באיחור של יומיים" / "יום שלישי, 15.9"
export function fmtRelative(date, now = new Date()) {
  const n = daysFromToday(date, now);
  if (n === 0) return 'היום';
  if (n === 1) return 'מחר';
  if (n === 2) return 'מחרתיים';
  if (n === -1) return 'אתמול';
  if (n < 0) {
    const a = Math.abs(n);
    if (a === 2) return 'באיחור של יומיים';
    if (a < 7) return `באיחור של ${a} ימים`;
    if (a < 14) return 'באיחור של שבוע';
    return `באיחור של ${Math.round(a / 7)} שבועות`;
  }
  if (n < 7) return `יום ${fmtDayName(date)}`;
  if (n < 14) return `בעוד שבוע · ${fmtDate(date)}`;
  return `${fmtDate(date)}`;
}

// ── טקסט ────────────────────────────────────────────────────────────
export const RLM = '‏';                 // סימן כיווניות — שומר על שורות שמתחילות בספרה בצד ימין
export const rtl = (line) => RLM + line;

export function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  if (d.length === 9 && d.startsWith('5')) d = '972' + d;
  return d;
}

// ניקוי טקסט לצורך השוואה: בלי ניקוד, בלי סימני פיסוק, בלי מילות קישור
const STOP = new Set(['את', 'של', 'עם', 'על', 'אל', 'לי', 'לו', 'לה', 'הוא', 'היא',
  'זה', 'זו', 'אני', 'הזה', 'צריך', 'צריכה', 'לזכור', 'תזכיר', 'תזכירי', 'ל', 'ב', 'ה']);

export function normalizeText(s) {
  return String(s || '')
    .replace(/[֑-ׇ]/g, '')
    .toLowerCase()
    .replace(/["'`׳״,.!?()\[\]{}\-–—:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s) {
  return normalizeText(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
}

// דמיון 0..1 בין שתי מחרוזות — שילוב של חפיפת מילים ומרחק עריכה
export function similarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hits = 0;
  for (const w of new Set(ta)) {
    if (setB.has(w)) { hits++; continue; }
    // התאמה חלקית: "ארנונה" מול "לארנונה"
    for (const x of setB) {
      if (x.length > 3 && w.length > 3 && (x.includes(w) || w.includes(x))) { hits += 0.8; break; }
    }
  }
  const setA = new Set(ta);
  const jaccard = hits / new Set([...ta, ...tb]).size;

  // הכלה: "לשלם ארנונה" מול "לשלם את הארנונה" — כל המילים המשמעותיות חוזרות.
  // ככל שהמשימות שונות באורכן, המשקל יורד (כדי ש"לקנות חלב" לא יתאים לכל רשימת קניות).
  const minSize = Math.min(setA.size, setB.size);
  const maxSize = Math.max(setA.size, setB.size);
  const containment = (hits / minSize) * (0.6 + 0.4 * (minSize / maxSize));

  const na = normalizeText(a), nb = normalizeText(b);
  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length, 1);

  return Math.min(1, Math.max(jaccard, containment * 0.95, lev * 0.9));
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
