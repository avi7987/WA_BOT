// בדיקות ליבה — התאריכים והפקודות. הרצה:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDue, parseCommand, parseTaskFallback, extractRecurrence, extractShared, mentionsTime } from '../src/parse.js';
import { ilParts, daysFromToday, makeIL } from '../src/util.js';
import { similarity } from '../src/util.js';

// יום שלישי, 15 בספטמבר 2026, 10:00 בישראל
const NOW = makeIL(2026, 9, 15, 10, 0);

const dayOffset = (d) => daysFromToday(d, NOW);

test('מחר / מחרתיים / היום', () => {
  assert.equal(dayOffset(extractDue('לשלם ארנונה מחר', NOW).due), 1);
  assert.equal(dayOffset(extractDue('להתקשר מחרתיים', NOW).due), 2);
  assert.equal(dayOffset(extractDue('לסדר היום', NOW).due), 0);
});

test('בעוד N ימים/שבועות/חודשים', () => {
  assert.equal(dayOffset(extractDue('בעוד 3 ימים', NOW).due), 3);
  assert.equal(dayOffset(extractDue('בעוד שבועיים', NOW).due), 14);
  assert.equal(dayOffset(extractDue('בעוד שבוע', NOW).due), 7);
  const m = extractDue('בעוד חודש', NOW).due;
  assert.equal(ilParts(m).m, 10);
});

test('יום בשבוע — תמיד ההופעה הבאה', () => {
  // 15.9.2026 הוא יום שלישי (wd=2)
  assert.equal(ilParts(NOW).wd, 2);
  assert.equal(dayOffset(extractDue('פגישה ביום חמישי', NOW).due), 2);
  assert.equal(dayOffset(extractDue('פגישה ביום ראשון', NOW).due), 5);
  assert.equal(dayOffset(extractDue('פגישה ביום שלישי', NOW).due), 7);   // "שלישי" הבא, לא היום
});

test('תאריך מספרי', () => {
  const r = extractDue('לשלם ב-20.9', NOW);
  assert.equal(ilParts(r.due).d, 20);
  assert.equal(ilParts(r.due).m, 9);
  // תאריך שכבר עבר השנה → השנה הבאה
  const past = extractDue('חידוש ב-1.3', NOW);
  assert.equal(ilParts(past.due).y, 2027);
});

test('שעה מדויקת מסמנת all_day=false', () => {
  const r = extractDue('פגישה מחר ב-14:30', NOW);
  assert.equal(r.allDay, false);
  assert.equal(ilParts(r.due).h, 14);
  assert.equal(ilParts(r.due).min, 30);
  assert.equal(dayOffset(r.due), 1);
});

test('"בערב" מזיז לשעות הערב', () => {
  const r = extractDue('להתקשר מחר ב-8 בערב', NOW);
  assert.equal(ilParts(r.due).h, 20);
  assert.equal(r.allDay, false);
});

test('ביטוי הזמן מוסר מהכותרת', () => {
  const t = parseTaskFallback('תזכיר לי לשלם ארנונה עד יום ראשון', NOW);
  assert.equal(t.title.includes('ראשון'), false);
  assert.equal(t.title.includes('תזכיר'), false);
  assert.match(t.title, /ארנונה/);
});

test('זיהוי משימה משותפת', () => {
  assert.equal(extractShared('משותף — להזמין מסעדה').shared, true);
  assert.equal(extractShared('להזמין מסעדה ביחד').shared, true);
  assert.equal(extractShared('להזמין מסעדה').shared, false);
});

test('זיהוי חזרתיות', () => {
  assert.equal(extractRecurrence('להוציא את הכלב כל יום').recurrence, 'daily');
  assert.equal(extractRecurrence('לשלוח דוח כל חודש').recurrence, 'monthly');
  assert.equal(extractRecurrence('לקנות חלב').recurrence, null);
});

test('פקודות מהירות', () => {
  assert.deepEqual(parseCommand('1'), { kind: 'done', refs: [1] });
  assert.deepEqual(parseCommand('1,3'), { kind: 'done', refs: [1, 3] });
  assert.deepEqual(parseCommand('בוצע 2'), { kind: 'done', refs: [2] });
  assert.equal(parseCommand('רשימה').kind, 'list');
  assert.equal(parseCommand('היום').filter, 'today');
  assert.equal(parseCommand('עזרה').kind, 'help');
  assert.equal(parseCommand('ביטול').kind, 'undo');
  assert.deepEqual(parseCommand('מחק 4'), { kind: 'delete', refs: [4] });
  const sn = parseCommand('דחה 2 מחר');
  assert.equal(sn.kind, 'snooze');
  assert.deepEqual(sn.refs, [2]);
  assert.equal(sn.when, 'מחר');
  assert.equal(parseCommand('סיכום בוקר 07:30').time, '07:30');
});

test('טקסט חופשי אינו נחשב פקודה', () => {
  assert.equal(parseCommand('לשלם ארנונה מחר'), null);
  assert.equal(parseCommand('להזמין מתנה לאמא'), null);
});

test('זיהוי אזכור שעה — הבלם על ה-AI', () => {
  const withTime = ['פגישה מחר ב-14:30', 'פגישה מחר בשתיים וחצי', 'להתקשר ב-8 בערב',
    'בשעה 9', 'להוציא את הכלב כל בוקר ב-7', 'תזכיר לי בעוד שעתיים', 'ישיבה בצהריים'];
  const withoutTime = ['לדבר מחר עם אפי קפיטל לגבי הרטיבות בסלון', 'לשלם ארנונה עד יום ראשון',
    'לקנות חלב', 'להזמין מתנה בעוד שבועיים', 'לחדש ביטוח ב-20.9'];
  for (const s of withTime) assert.equal(mentionsTime(s), true, s);
  for (const s of withoutTime) assert.equal(mentionsTime(s), false, s);
});

test('דמיון בין משימות מזהה כפילות', () => {
  assert.ok(similarity('לשלם ארנונה', 'לשלם את הארנונה') > 0.7);
  assert.ok(similarity('לשלם ארנונה', 'לקנות חלב') < 0.4);
});
