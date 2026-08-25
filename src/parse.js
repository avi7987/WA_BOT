// =====================================================================
//  parse.js — הבנה "בלי AI": פקודות מהירות + תאריכים בעברית.
//
//  זה המסלול המהיר. כל מה שהוא לא מזהה עובר ל-LLM (llm.js).
//  היתרון: פקודות יומיומיות ("1", "דחה 2 מחר") עובדות מיידית,
//  בלי קריאת רשת, וגם אם אין מפתח AI בכלל.
// =====================================================================
import { ilParts, makeIL, addDays, addMonths, ilStartOfDay } from './util.js';

const HEB_DAY_NAMES = {
  'ראשון': 0, 'א': 0, 'שני': 1, 'ב': 1, 'שלישי': 2, 'ג': 2, 'רביעי': 3, 'ד': 3,
  'חמישי': 4, 'ה': 4, 'שישי': 5, 'ו': 5, 'שבת': 6, 'ש': 6,
};

const HEB_MONTH_NAMES = {
  'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6,
  'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
};

// חשוב: \b של JavaScript לא עובד על עברית (אותיות עבריות אינן \w),
// ולכן "גבול מילה" נבנה כאן במפורש עם lookaround.
const NW = '(?<![א-תA-Za-z0-9])';     // אין אות/ספרה לפני
const NA = '(?![א-תA-Za-z0-9])';      // אין אות/ספרה אחרי
const w = (body, flags = '') => new RegExp(NW + '(?:' + body + ')' + NA, flags);

// מילים שמסמנות "זו משימה משותפת"
const SHARED_WORDS = w('משותף|משותפת|משותפים|משותפות|ביחד|שנינו|לשנינו|#משותף|עם אשתי|עם בעלי|עם בן ?הזוג|עם בת ?הזוג');

// ── תאריך ושעה מתוך טקסט חופשי ───────────────────────────────────────
/**
 * מחזיר { due, allDay, cleaned } — התאריך שזוהה, האם נקבעה שעה,
 * והטקסט אחרי הסרת ביטוי הזמן (כדי שיישאר שם משימה נקי).
 */
export function extractDue(text, now = new Date()) {
  let s = ' ' + String(text || '') + ' ';
  const p = ilParts(now);
  let day = null;          // Date בתחילת היום
  let hour = null, minute = 0;

  const eat = (re) => {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return m;
  };

  // --- שעה מפורשת: "ב-14:00" / "בשעה 8" / "ב8 בערב" ---
  let m;
  if ((m = eat(/(?:בשעה|ב-?)\s?([01]?\d|2[0-3])[:.]([0-5]\d)/))) {
    hour = +m[1]; minute = +m[2];
  } else if ((m = eat(/(?:בשעה|ב-?)\s?([1-9]|1\d|2[0-3])\s*(בבוקר|בצהריים|אחה"?צ|אחרי ?הצהריים|בערב|בלילה)/))) {
    hour = +m[1];
    const part = m[2];
    if (/ערב|לילה|צהר|אחה/.test(part) && hour < 12) hour += 12;
    if (/בוקר/.test(part) && hour === 12) hour = 0;
  } else if ((m = eat(/בשעה\s?([1-9]|1\d|2[0-3])(?![\d:.])/))) {
    hour = +m[1];
    if (hour <= 7) hour += 12;      // "בשעה 5" בעברית מדוברת = 17:00
  } else if ((m = eat(w('בבוקר|בצהריים|בערב|בלילה')))) {
    hour = { 'בבוקר': 9, 'בצהריים': 13, 'בערב': 19, 'בלילה': 21 }[m[0]];
  }

  // --- "בעוד N שעות/דקות" — יעד יחסי לרגע הזה ---
  //     (היחידה חובה כשנאמר מספר, אחרת "בעוד 3 ימים" היה נקרא כ-3 שעות)
  if ((m = eat(/בעוד\s+(?:(שעה|שעתיים)|(\d+)\s*(שעות|דקות|דקה|דק'?))/))) {
    const n = m[1] === 'שעה' ? 1 : m[1] === 'שעתיים' ? 2 : +m[2];
    const isMin = /דק/.test(m[3] || '');
    const due = new Date(now.getTime() + n * (isMin ? 60e3 : 3600e3));
    return { due, allDay: false, cleaned: clean(s) };
  }

  // --- ימים יחסיים ---
  if (eat(w('היום'))) day = ilStartOfDay(now);
  else if (eat(w('מחרתיים'))) day = addDays(ilStartOfDay(now), 2);
  else if (eat(w('מחר'))) day = addDays(ilStartOfDay(now), 1);
  else if (eat(w('אתמול'))) day = addDays(ilStartOfDay(now), -1);
  else if ((m = eat(/בעוד\s+(יומיים|שבועיים|חודשיים|שנתיים|יום|שבוע|חודש|שנה|\d+)\s*(ימים|יום|שבועות|שבוע|חודשים|חודש|שנים|שנה)?/))) {
    const word = m[1], unit = m[2] || '';
    const dual = { 'יומיים': [2, 'd'], 'שבועיים': [14, 'd'], 'חודשיים': [2, 'M'], 'שנתיים': [2, 'y'] }[word];
    if (dual) {
      day = dual[1] === 'd' ? addDays(ilStartOfDay(now), dual[0])
        : dual[1] === 'M' ? addMonths(ilStartOfDay(now), dual[0])
          : addMonths(ilStartOfDay(now), dual[0] * 12);
    } else {
      const n = /^\d+$/.test(word) ? +word : 1;
      const u = /^\d+$/.test(word) ? unit : word;
      if (/שבוע/.test(u)) day = addDays(ilStartOfDay(now), n * 7);
      else if (/חודש/.test(u)) day = addMonths(ilStartOfDay(now), n);
      else if (/שנה|שנים/.test(u)) day = addMonths(ilStartOfDay(now), n * 12);
      else day = addDays(ilStartOfDay(now), n);
    }
  } else if (eat(w('שבוע הבא|בשבוע הבא'))) day = addDays(ilStartOfDay(now), 7);
  else if (eat(w('החודש הבא|בחודש הבא'))) day = addMonths(ilStartOfDay(now), 1);
  else if (eat(w('סוף השבוע|בסוף השבוע|סופ"ש'))) day = nextWeekday(now, 5);
  // --- יום בשבוע: "ביום ראשון" / "יום ה'" / "לשלישי" ---
  else if ((m = eat(/(?:ביום|יום|ל?יום)\s+([א-ת]{1,6})['׳]?/)) && HEB_DAY_NAMES[m[1]] !== undefined) {
    day = nextWeekday(now, HEB_DAY_NAMES[m[1]]);
  } else if ((m = eat(w('[בל](?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)')))) {
    day = nextWeekday(now, HEB_DAY_NAMES[m[0].slice(1)]);
  }
  // --- תאריך מספרי: 15.9 / 15/9/26 / 15.09.2026 ---
  else if ((m = eat(/(?:עד\s+)?(?:ב-?|ה-?)?(?<![\d./])([0-3]?\d)[./]([01]?\d)(?:[./](\d{2,4}))?(?![\d.])/))) {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : p.y;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      day = makeIL(y, mo, d, 0, 0);
      if (!m[3] && day.getTime() < ilStartOfDay(now).getTime()) day = makeIL(y + 1, mo, d, 0, 0);
    }
  }
  // --- "ב-15 בספטמבר" / "15 לספטמבר" ---
  else if ((m = eat(/(?:ב-?|ה-?)?(?<!\d)([0-3]?\d)\s+[בל]?(ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)(?![א-ת])/))) {
    const d = +m[1], mo = HEB_MONTH_NAMES[m[2]];
    day = makeIL(p.y, mo, d, 0, 0);
    if (day.getTime() < ilStartOfDay(now).getTime()) day = makeIL(p.y + 1, mo, d, 0, 0);
  }
  // --- "ב-15 לחודש" ---
  else if ((m = eat(/(?:ב-?|ה-?)(?<!\d)([0-3]?\d)\s+לחודש(?![א-ת])/))) {
    const d = +m[1];
    day = makeIL(p.y, p.m, d, 0, 0);
    if (day.getTime() < ilStartOfDay(now).getTime()) day = addMonths(day, 1);
  }

  // מילות עזר שנשארו ("עד", "ב־") — מנקים
  s = s.replace(/\s+(עד|בשעה)\s*$/g, ' ');

  if (day === null && hour === null) return { due: null, allDay: true, cleaned: clean(s) };

  // רק שעה בלי יום → היום; ואם השעה כבר עברה → מחר
  if (day === null) {
    day = ilStartOfDay(now);
    const dp = ilParts(day);
    let due = makeIL(dp.y, dp.m, dp.d, hour, minute);
    if (due.getTime() <= now.getTime()) due = addDays(due, 1);
    return { due, allDay: false, cleaned: clean(s) };
  }

  const dp = ilParts(day);
  if (hour === null) return { due: makeIL(dp.y, dp.m, dp.d, 9, 0), allDay: true, cleaned: clean(s) };
  return { due: makeIL(dp.y, dp.m, dp.d, hour, minute), allDay: false, cleaned: clean(s) };
}

// היום הקרוב בשבוע שהוא wd (אם היום הוא אותו יום — השבוע הבא)
function nextWeekday(now, wd) {
  const today = ilStartOfDay(now);
  const cur = ilParts(today).wd;
  let diff = (wd - cur + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(today, diff);
}

function clean(s) {
  return s.replace(/\s+/g, ' ')
    .replace(/^[\s,.\-–—:]+|[\s,.\-–—:]+$/g, '')
    .trim();
}

// ── האם בכלל נאמרה שעה? ─────────────────────────────────────────────
//  משמש כבלם על ה-AI: הוא נוטה להמציא 09:00 גם כשלא ביקשת שעה,
//  וזה ההבדל בין משימה ליום שלם לבין משימה שתצלצל לך באמצע היום.
const SPELLED_HOURS = 'אחת|שתיים|שתים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר|אחת עשרה|שתים עשרה';
const TIME_HINTS = [
  /([01]?\d|2[0-3])[:.][0-5]\d/,                       // 14:30
  /בשעה/,
  w('בבוקר|בצהריים|בערב|בלילה|אחה"?צ|אחרי הצהריים|לפנות בוקר'),
  /[בל]-?\s?([01]?\d|2[0-3])(\s|$)/,                   // "ב-7", "ל-8"
  new RegExp('[בל](' + SPELLED_HOURS + ')'),           // "בשתיים"
  w('וחצי|ורבע|בעוד שעה|בעוד שעתיים'),
  /בעוד\s+\d+\s*(שעות|דקות|דק)/,
];

export function mentionsTime(text) {
  const s = String(text || '');
  return TIME_HINTS.some((re) => re.test(s));
}

// ── חזרתיות ─────────────────────────────────────────────────────────
const RECURRENCE_RULES = [
  ['daily', w('כל יום|מדי יום|יומי')],
  ['weekly', w('כל שבוע|מדי שבוע|שבועי')],
  ['monthly', w('כל חודש|מדי חודש|חודשי')],
  ['yearly', w('כל שנה|מדי שנה|שנתי')],
];

export function extractRecurrence(text) {
  const s = String(text || '');
  for (const [kind, re] of RECURRENCE_RULES) {
    if (re.test(s)) return { recurrence: kind, cleaned: s.replace(re, '').replace(/\s+/g, ' ').trim() };
  }
  return { recurrence: null, cleaned: s };
}

export function extractShared(text) {
  const s = String(text || '');
  if (!SHARED_WORDS.test(s)) return { shared: false, cleaned: s };
  return { shared: true, cleaned: s.replace(SHARED_WORDS, '').replace(/\s+/g, ' ').trim() };
}

// ── פקודות מהירות ───────────────────────────────────────────────────
/**
 * מחזיר null אם זו לא פקודה מוכרת (ואז הטקסט הולך ל-LLM).
 */
export function parseCommand(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ');

  // עזרה
  if (/^(עזרה|help|\?|מה אתה יודע לעשות)$/i.test(t)) return { kind: 'help' };

  // אישור / דחייה לשאלה ממתינה
  if (/^(כן|בטח|אישור|ok|כן בבקשה|יאללה)$/i.test(t)) return { kind: 'yes' };
  if (/^(לא|בטל|לא תודה|עזוב)$/i.test(t)) return { kind: 'no' };

  // ביטול הפעולה האחרונה
  if (/^(ביטול|בטל אחרון|טעות|אופס)$/i.test(t)) return { kind: 'undo' };

  // בקשת רשימה בניסוח חופשי — חשוב במיוחד כשה-AI לא זמין,
  // אחרת "תציג לי את רשימת המשימות" היה נשמר בטעות כמשימה חדשה.
  const asked = parseListIntent(t);
  if (asked) return asked;

  // רשימות
  if (/^(רשימה|המשימות|מה יש לי|מה נשאר|סטטוס|רענן)$/.test(t)) return { kind: 'list', filter: 'digest' };
  if (/^(היום|מה היום|מה יש לי היום)$/.test(t)) return { kind: 'list', filter: 'today' };
  if (/^(מחר|מה מחר|מה יש לי מחר)$/.test(t)) return { kind: 'list', filter: 'tomorrow' };
  if (/^(באיחור|פג תוקף|איחורים|מה באיחור)$/.test(t)) return { kind: 'list', filter: 'overdue' };
  if (/^(השבוע|מה השבוע)$/.test(t)) return { kind: 'list', filter: 'week' };
  if (/^(הכל|כל המשימות|רשימה מלאה)$/.test(t)) return { kind: 'list', filter: 'all' };
  if (/^(משותף|משותפות|הרשימה המשותפת|שלנו)$/.test(t)) return { kind: 'list', filter: 'shared' };
  if (/^(בוצעו|מה עשיתי|היסטוריה)$/.test(t)) return { kind: 'list', filter: 'done' };

  // סימון בוצע: "1"  "1,3"  "1 3"  "בוצע 2"  "סיימתי 4"
  let m = /^(?:בוצע|בוצעו|סיימתי|עשיתי|גמרתי|✓|✔️?|v)\s*([\d,\s.]+)$/i.exec(t);
  if (m) { const ns = numbers(m[1]); if (ns.length) return { kind: 'done', refs: ns }; }
  if (/^[\d]+(\s*[,\s]\s*\d+)*$/.test(t)) {
    const ns = numbers(t);
    if (ns.length) return { kind: 'done', refs: ns };
  }

  // דחייה: "דחה 2 מחר" / "דחה 2 לשבוע הבא" / "העבר 3 ליום ראשון"
  m = /^(?:דח[היף]?|תדח[הי]|העבר|תעביר|שנה תאריך)\s+([\d,\s]+)\s*(.*)$/.exec(t);
  if (m) {
    const ns = numbers(m[1]);
    if (ns.length) return { kind: 'snooze', refs: ns, when: (m[2] || 'מחר').trim() };
  }

  // מחיקה: "מחק 3" / "בטל 3"
  m = /^(?:מחק|תמחק|הסר|בטל|תבטל)\s+([\d,\s]+)$/.exec(t);
  if (m) { const ns = numbers(m[1]); if (ns.length) return { kind: 'delete', refs: ns }; }

  // שיתוף / ביטול שיתוף
  m = /^(?:שתף|תשתף)\s+([\d,\s]+)$/.exec(t);
  if (m) { const ns = numbers(m[1]); if (ns.length) return { kind: 'share', refs: ns, shared: true }; }
  m = /^(?:בטל שיתוף|הפרד)\s+([\d,\s]+)$/.exec(t);
  if (m) { const ns = numbers(m[1]); if (ns.length) return { kind: 'share', refs: ns, shared: false }; }

  // הערה על משימה: "הערה 3: כבר קניתי חלב"  /  "הערה 3 כבר קניתי"
  m = /^(?:הערה|תערה|הוסף הערה|רשום ל)\s*(\d+)\s*[:,\-–]?\s*(.+)$/.exec(t);
  if (m) return { kind: 'note_add', ref: +m[1], text: m[2].trim() };

  // צפייה בהערות: "הערות 3" / "מה ההערות על 3" / "תראה הערות 3"
  m = /^(?:הערות|מה ההערות(?: על)?|תראה(?: לי)? (?:את ה)?הערות(?: של| על)?|הצג הערות)\s*(\d+)$/.exec(t);
  if (m) return { kind: 'note_show', ref: +m[1] };

  // ── רשימות ייחוס ──
  if (/^(רשימות|הרשימות שלי|אילו רשימות|כל הרשימות)$/.test(t)) return { kind: 'lists_overview' };

  // "תפתח רשימה של ספרים" / "צור רשימה חדשה: יינות"
  m = /^(?:תפתח|פתח|צור|תיצור|תוסיף)\s+רשימה(?:\s+חדשה)?(?:\s+(?:של|בשם|ל))?\s*[:\-–]?\s*(.+)$/.exec(t);
  if (m) return { kind: 'list_create', name: m[1].trim() };

  // "תוסיף למסעדות: קפה איטליה, פלורנטין תל אביב"
  m = /^(?:תוסיף|הוסף|תרשום|רשום)\s+ל([^:,\-–]{2,30}?)\s*[:\-–]\s*(.+)$/.exec(t);
  if (m) return { kind: 'list_add', listQuery: m[1].trim(), text: m[2].trim() };

  // "תמחק מהמסעדות 3" / "הסר ממסעדות 2"
  m = /^(?:תמחק|מחק|הסר|תסיר)\s+מ(?:ה)?([^\d]{2,30}?)\s+(\d{1,3})$/.exec(t);
  if (m) return { kind: 'list_remove', listQuery: m[1].trim(), ref: +m[2] };

  // ── הודעות יוצאות ──
  if (/^(הודעות|הודעות ממתינות|מה ממתין לשליחה)$/.test(t)) return { kind: 'msg_list' };
  if (/^(נשלחו היום|מה שלחתי היום|יומן שליחות)$/.test(t)) return { kind: 'msg_sent_today' };

  m = /^(?:הודעה|תראה הודעה|הצג הודעה)\s+(\d+)$/.exec(t);
  if (m) return { kind: 'msg_show', ref: +m[1] };

  m = /^(?:בטל הודעה|תבטל(?: את ה)?הודעה|מחק הודעה)\s+(\d+)$/.exec(t);
  if (m) return { kind: 'msg_cancel', ref: +m[1] };

  m = /^(?:שנה הודעה|ערוך הודעה|תשנה(?: את ה)?הודעה)\s+(\d+)\s*[:,\-–]?\s*(.+)$/.exec(t);
  if (m) return { kind: 'msg_edit', ref: +m[1], text: m[2].trim() };

  m = /^(?:שלח הודעה|תשלח(?: את ה)?הודעה)\s+(\d+)$/.exec(t);
  if (m) return { kind: 'msg_send', ref: +m[1] };

  m = /^(?:בדוק הודעה|תבדוק הודעה)\s+(\d+)$/.exec(t);
  if (m) return { kind: 'msg_test', ref: +m[1] };

  // שינוי שעת סיכום הבוקר
  m = /^(?:סיכום בוקר|שעת בוקר|תעיר אותי)\s+(?:ב-?\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(t);
  if (m) return { kind: 'digest_time', time: `${String(+m[1]).padStart(2, '0')}:${m[2]}` };

  // אחרון — פעולה על משימה קיימת בניסוח חופשי ("סיימתי את משימה 5")
  const vr = parseVerbRef(t);
  if (vr) return vr;

  return null;
}

// ── "תציג לי את הרשימה" על כל גלגוליו ───────────────────────────────
const ASKING = /^(תציג|תראה|הצג|תשלח|שלח|תן|תביא|רוצה לראות|אפשר לראות|מה)/;
const ABOUT_TASKS = /(רשימ|משימ|מה יש לי|מה נשאר|מה נותר)/;
// מילים שמסגירות שזו בקשה חדשה ולא שאילתה ("תוסיף משימה לרשימה")
const ADDING = /(תוסיף|הוסף|תרשום|רשום|תזכיר|צריך|תכניס)/;

function parseListIntent(t) {
  if (ADDING.test(t)) return null;
  if (!ABOUT_TASKS.test(t)) return null;
  if (!ASKING.test(t) && !/^(רשימת|המשימות)/.test(t)) return null;

  // אם צוין טווח זמן — מכבדים אותו
  if (/באיחור|פג תוקף|איחורים/.test(t)) return { kind: 'list', filter: 'overdue' };
  if (/היום/.test(t)) return { kind: 'list', filter: 'today' };
  if (/מחר/.test(t)) return { kind: 'list', filter: 'tomorrow' };
  if (/השבוע/.test(t)) return { kind: 'list', filter: 'week' };
  if (/משותפ|ביחד|שנינו/.test(t)) return { kind: 'list', filter: 'shared' };
  if (/הכל|כל המשימות|מלאה/.test(t)) return { kind: 'list', filter: 'all' };
  return { kind: 'list', filter: 'digest' };
}

// ── פעולה על משימה קיימת, בניסוח חופשי ──────────────────────────────
//  "סיימתי את משימה 5" · "תמחק את 3" · "תדחה את משימה 2 למחר"
//  הניסוחים האלה נפוצים מדי מכדי להיות תלויים ב-AI, וטעות בהם
//  (יצירת משימה חדשה במקום סגירת קיימת) היא הרסנית.
const VERBS = [
  ['done', w('סיימתי|סיימנו|בוצע|בוצעו|בוצעה|עשיתי|גמרתי|טיפלתי|סגרתי|ביצעתי|הושלמה|הושלם|השלמתי|כבר עשיתי|כבר טיפלתי')],
  ['delete', w('מחק|תמחק|למחוק|הסר|תסיר|הורד|תוריד|בטל את|תבטל את')],
  ['snooze', w('דחה|דחי|תדחה|לדחות|העבר|תעביר|תזיז|הזז|שנה תאריך')],
];

const REF_MARKER = /(משימ(?:ה|ות)|מספר|מס['׳]?)\s*(\d{1,3})/;

function parseVerbRef(t) {
  let verb = null, verbEnd = -1;
  for (const [kind, re] of VERBS) {
    const m = re.exec(t);
    if (m) { verb = kind; verbEnd = m.index + m[0].length; break; }
  }
  if (!verb) return null;

  const rest = t.slice(verbEnd);
  // הפועל יכול לבוא גם אחרי ההפניה ("משימה 5 בוצעה") — אז מחפשים בכל הטקסט
  const marked = REF_MARKER.exec(rest) || REF_MARKER.exec(t);

  let refs, tail;
  if (marked) {
    refs = [parseInt(marked[2], 10)];
    tail = rest.slice(marked.index + marked[0].length);
    // "סיימתי את משימות 3 ו-5"
    const more = tail.match(/^\s*(?:,|ו-?|ואת)\s*(\d{1,3})/);
    if (more) { refs.push(parseInt(more[1], 10)); tail = tail.slice(more[0].length); }
  } else {
    // בלי המילה "משימה" — דורשים שהמספר יופיע מיד אחרי הפועל,
    // ושלא יבוא אחריו טקסט נוסף. אחרת "סיימתי לקנות 5 קילו
    // עגבניות" היה נקרא בטעות כסגירת משימה 5.
    const near = /^(?:\s*(?:את|ה)?\s*)(\d{1,3})((?:\s*(?:,|ו-?)\s*\d{1,3})*)\s*(.*)$/.exec(rest);
    if (!near) return null;
    tail = near[3] || '';
    if (verb !== 'snooze' && tail.trim()) return null;   // יש טקסט אחרי המספר — כנראה לא הפניה
    refs = [parseInt(near[1], 10), ...(near[2].match(/\d{1,3}/g) || []).map(Number)];
  }

  refs = refs.filter((n) => n > 0 && n < 1000);
  if (!refs.length) return null;

  if (verb === 'snooze') return { kind: 'snooze', refs, when: (tail || '').trim() || 'מחר' };
  return { kind: verb === 'done' ? 'done' : 'delete', refs };
}

/**
 * האם הטקסט מתייחס למשימה קיימת? משמש כבלם: כשה-AI לא זמין,
 * עדיף לומר "לא הבנתי" מאשר ליצור משימה בשם "סיימתי את משימה 5".
 */
export function looksLikeTaskReference(text) {
  const t = String(text || '').trim();
  if (REF_MARKER.test(t)) return true;
  return VERBS.some(([, re]) => re.test(t));
}

function numbers(s) {
  return String(s).split(/[,\s.]+/).map((x) => parseInt(x, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 1000);
}

// ── שיוך ורמזי שיתוף, בלי AI ────────────────────────────────────────
/**
 * names = { ownerName, partnerName }
 * מחזיר { assign: 'me'|'partner'|null, shared: bool, cleaned }
 * שיוך תמיד גורר שיתוף — אין שיוך בתוך אזור אישי.
 */
export function extractAssignee(text, names = {}) {
  let s = String(text || '');
  const esc = (x) => String(x || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const p = names.partnerName ? esc(names.partnerName) : null;
  const o = names.ownerName ? esc(names.ownerName) : null;

  const strip = (re) => { const m = re.exec(s); if (m) s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(); return !!m; };

  if (p) {
    // "תטיל על איה ..." / "שאיה ..." / "תבקש מאיה ..." / "איה — ..."
    const forPartner = new RegExp(`(תטיל על ${p}|תעביר ל${p}|תבקש מ${p}|ש${p}\\s|${p}\\s*[—–-]\\s*|בשביל ${p}|על ${p}\\s)`);
    if (strip(forPartner)) return { assign: 'partner', shared: true, cleaned: s };
  }
  if (o) {
    const forMe = new RegExp(`(אני א[קט]\\S*|אני מטפל\\S*|ש?${o}\\s*[—–-]\\s*|עליי\\b)`);
    if (strip(forMe)) return { assign: 'me', shared: true, cleaned: s };
  }
  // בלי שיוך מפורש, אבל ניסוח שמרמז על שניהם
  if (/(צריך שמישהו|שמישהו מאיתנו|אנחנו צריכים|אנחנו חייבים)/.test(s)) {
    return { assign: null, shared: true, cleaned: s.replace(/(צריך שמישהו|שמישהו מאיתנו|אנחנו צריכים|אנחנו חייבים)/, '').trim() };
  }
  return { assign: null, shared: false, cleaned: s };
}

// ── ניסוח משימה מטקסט חופשי, בלי AI ─────────────────────────────────
export function parseTaskFallback(text, now = new Date(), names = {}) {
  let s = String(text || '').trim();
  // מסירים פתיחים נפוצים
  s = s.replace(/^(תזכיר לי|תזכירי לי|תזכורת|צריך|צריכה|אני צריך|אני צריכה|יש לי|לזכור|תוסיף|תוסיפי|הוסף|משימה)[\s:,-]*/i, '');

  const asg = extractAssignee(s, names); s = asg.cleaned;
  const sh = extractShared(s); s = sh.cleaned;
  const rec = extractRecurrence(s); s = rec.cleaned;
  const due = extractDue(s, now);
  let title = due.cleaned.replace(/^(ל|את|ב)\s+/, '').trim();
  if (!title) title = String(text || '').trim();

  return {
    title: title.slice(0, 200),
    due_at: due.due ? due.due.toISOString() : null,
    all_day: due.allDay,
    shared: sh.shared || asg.shared,
    assign: asg.assign,
    recurrence: rec.recurrence,
  };
}
