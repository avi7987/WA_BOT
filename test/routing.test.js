// לאן הולך טקסט חופשי: משימה, רשימת ייחוס, או רעיון?
// זו ההחלטה הכי שברירית במערכת, ולכן היא נבדקת בנפרד —
// כולל המצב שבו ה-AI לא זמין בכלל.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-db.js';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.LLM_PROVIDER = 'none';        // בכוונה: בודקים את המסלול בלי AI

const db = await import('../src/db.js');
db.__setClientForTests(createFakeSupabase());
const { classifyIntent } = await import('../src/parse.js');
const { handleMessage } = await import('../src/brain.js');

let owner, food;
const deps = { partnerOf: () => null, notify: async () => {}, users: () => [owner] };

test('הקמה', async () => {
  owner = await db.upsertUser('owner', { name: 'אבי', role: 'owner', sees_own_tasks: true });
  food = await db.createList({
    name: 'מסעדות ובתי קפה', aliases: ['מסעדות', 'בתי קפה', 'קפה'],
    icon: '🍽️', shared: true, owner_id: owner.id,
  });
});

test('סיווג מקומי — משימה', async () => {
  const lists = await db.getLists();
  assert.equal(classifyIntent('לקנות חלב מחר', lists), 'task');
  assert.equal(classifyIntent('להתקשר למוסך', lists), 'task');
  assert.equal(classifyIntent('תזכיר לי לשלם ארנונה', lists), 'task');
});

test('סיווג מקומי — רעיון לפיתוח', async () => {
  const lists = await db.getLists();
  assert.equal(classifyIntent('רעיון תוסיף אפשרות לצרף תמונות', lists), 'idea');
  assert.equal(classifyIntent('היה נחמד אם היית יודע לזהות כתובות', lists), 'idea');
  assert.equal(classifyIntent('באג התזכורת הגיעה פעמיים', lists), 'idea');
  assert.equal(classifyIntent('תוסיף אפשרות לסנכרן ליומן', lists), 'idea');
});

test('סיווג מקומי — פריט לרשימה', async () => {
  const lists = await db.getLists();
  assert.equal(classifyIntent('תוסיף למסעדות את מיזו', lists), 'list');
  // אזכור סתמי של שם רשימה אינו מספיק — עדיף לשאול מאשר לתייק לא נכון
  assert.equal(classifyIntent('קפה איטליה פלורנטין', lists), 'unknown');
});

test('סימנים חזקים גוברים על אזכור שם רשימה', async () => {
  const lists = await db.getLists();
  // מזכיר "מסעדה" אבל יש תאריך — זו משימה, לא פריט ברשימה
  assert.equal(classifyIntent('להזמין מסעדה ליום שישי', lists), 'task');
  assert.equal(classifyIntent('משותף — להזמין מסעדה ליום שישי', lists), 'task');
  assert.equal(classifyIntent('שאיה תזמין מסעדה ביום ראשון', lists), 'task');
});

test('בלי AI: רעיון נשמר בתיבה ולא הופך למשימה', async () => {
  const reply = await handleMessage(owner, 'היה נחמד אם היית יודע לצרף תמונות', deps);
  assert.match(reply, /💡/);
  assert.equal((await db.openRequests()).length, 1);
  assert.equal((await db.openTasksFor(owner)).length, 0, 'לא נוצרה משימה');
});

test('בלי AI: משימה ברורה נכנסת כמשימה', async () => {
  const reply = await handleMessage(owner, 'לקנות חלב מחר', deps);
  assert.match(reply, /✅/);
  const tasks = await db.openTasksFor(owner);
  assert.ok(tasks.some((t) => /חלב/.test(t.title)));
});

test('בלי AI: טקסט מעורפל → הבוט שואל, לא מנחש', async () => {
  const before = (await db.openTasksFor(owner)).length;
  const ask = await handleMessage(owner, 'קפה איטליה פלורנטין', deps);
  assert.match(ask, /לאן לשייך/);
  assert.match(ask, /1 · משימה שלי/);
  assert.equal((await db.openTasksFor(owner)).length, before, 'שום דבר לא נוצר עד שעונים');
});

test('התשובה לשאלה מתייקת למקום שבחרת', async () => {
  await handleMessage(owner, 'מקום כלשהו שלא ברור', deps);   // מייצר שאלה
  const before = (await db.openRequests()).length;
  const reply = await handleMessage(owner, '2', deps);          // 2 = רעיון (אין רשימה מנוחשת)
  assert.match(reply, /💡/);
  assert.equal((await db.openRequests()).length, before + 1);
});

// ── סיכום יומי לא הולך לאיבוד כשהוואטסאפ מנותק ─────────────────────
test('סיכום בוקר לא "נשרף" כשהשליחה נכשלה', async () => {
  const { startScheduler } = await import('../src/scheduler.js');
  assert.ok(startScheduler, 'המתזמן נטען');

  // מדמים: הסימון היומי נתפס, ואז השליחה נכשלה
  const claimed = await db.claimDaily(owner.id, 'digest_morning');
  assert.equal(claimed, true, 'הסימון נתפס');
  assert.equal(await db.claimDaily(owner.id, 'digest_morning'), false, 'לא נתפס פעמיים');

  await db.releaseDaily(owner.id, 'digest_morning');
  assert.equal(await db.claimDaily(owner.id, 'digest_morning'), true,
    'אחרי שחרור אפשר לנסות שוב — כך הסיכום מגיע כשהחיבור חוזר');
});
