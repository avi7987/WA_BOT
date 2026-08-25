// בדיקות ליבה — התאריכים והפקודות. הרצה:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDue, parseCommand, parseTaskFallback, extractRecurrence, extractShared, mentionsTime, looksLikeTaskReference } from '../src/parse.js';
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

test('בקשת רשימה בניסוח חופשי מזוהה — גם בלי AI', () => {
  const asList = (s, filter = 'digest') => {
    const c = parseCommand(s);
    assert.ok(c, `לא זוהה: ${s}`);
    assert.equal(c.kind, 'list', s);
    assert.equal(c.filter, filter, s);
  };
  asList('תציג לי את רשימת המשימות שלי');
  asList('תראה לי את המשימות');
  asList('הצג רשימה');
  asList('מה המשימות שלי');
  asList('תציג את המשימות של היום', 'today');
  asList('תראה לי מה יש לי מחר', 'tomorrow');
  asList('תציג את המשימות באיחור', 'overdue');
  asList('תראה את הרשימה המשותפת', 'shared');

  // ולא לבלוע בקשות הוספה שמזכירות "רשימה"
  assert.equal(parseCommand('תוסיף משימה לרשימה: לקנות חלב'), null);
  assert.equal(parseCommand('תזכיר לי לבדוק את הרשימה בסופר'), null);
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

test('פעולה על משימה קיימת בניסוח חופשי — הבאג שדווח מהשטח', () => {
  const expect = (txt, kind, refs) => {
    const c = parseCommand(txt);
    assert.ok(c, `לא זוהה: ${txt}`);
    assert.equal(c.kind, kind, txt);
    if (refs) assert.deepEqual(c.refs, refs, txt);
  };
  // אלה הפכו קודם למשימות חדשות במקום לסגור את הקיימת
  expect('סיימתי את משימה 5', 'done', [5]);
  expect('סיימתי משימה 5', 'done', [5]);
  expect('משימה 5 בוצעה', 'done', [5]);
  expect('סיימתי את 5', 'done', [5]);
  expect('סיימתי את משימות 3 ו-5', 'done', [3, 5]);
  expect('גמרתי את 7', 'done', [7]);
  expect('טיפלתי במשימה 4', 'done', [4]);
  expect('תמחק את משימה 3', 'delete', [3]);
  expect('מחק את 3', 'delete', [3]);
  expect('תדחה את משימה 2 למחר', 'snooze', [2]);
});

test('לא לפרש מספרים תמימים כהפניה למשימה', () => {
  const notAction = (txt) => {
    const c = parseCommand(txt);
    assert.ok(!c || !['done', 'delete', 'snooze'].includes(c.kind), `זוהה בטעות: ${txt} → ${JSON.stringify(c)}`);
  };
  notAction('סיימתי לקנות 5 קילו עגבניות');
  notAction('דחה את הפגישה ל-3 בדצמבר');
  notAction('לקנות 5 בקבוקי יין');
  notAction('להתקשר למוסך');
});

test('הבלם מזהה התייחסות למשימה קיימת', () => {
  assert.equal(looksLikeTaskReference('סיימתי את משימה 5'), true);
  assert.equal(looksLikeTaskReference('משימה 5 בוצעה'), true);
  assert.equal(looksLikeTaskReference('תמחק את זה'), true);
  assert.equal(looksLikeTaskReference('להתקשר למוסך מחר'), false);
  assert.equal(looksLikeTaskReference('לקנות חלב'), false);
});
