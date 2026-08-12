// בדיקת מסלול מלא — הודעה נכנסת → משימה → רשימה → סימון בוצע,
// כולל כפילויות והרשימה המשותפת. רץ על בסיס נתונים בזיכרון, בלי רשת.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-db.js';

// חייב להיקבע לפני שמייבאים את הקוד עצמו — ולכן ייבוא דינמי.
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.LLM_PROVIDER = 'none';        // בודקים את המסלול המקומי, בלי AI

const db = await import('../src/db.js');
db.__setClientForTests(createFakeSupabase());

const { handleMessage } = await import('../src/brain.js');
const R = await import('../src/render.js');

let owner, partner;
const sent = [];                           // הודעות שנשלחו לצד השני

const deps = {
  partnerOf: (u) => (u.session_key === 'owner' ? partner : owner),
  notify: async (u, text) => { sent.push({ to: u.session_key, text }); },
};

test('הקמה', async () => {
  owner = await db.upsertUser('owner', { name: 'אבישי', role: 'owner', sees_own_tasks: true, default_shared: false });
  partner = await db.upsertUser('partner', { name: 'איה', role: 'member', sees_own_tasks: false, default_shared: true });
  assert.ok(owner.id && partner.id);
});

test('הוספת משימה בטקסט חופשי', async () => {
  const reply = await handleMessage(owner, 'תזכיר לי לשלם ארנונה מחר', deps);
  assert.match(reply, /✅/);
  assert.match(reply, /ארנונה/);
  assert.match(reply, /מחר/);
  const open = await db.openTasksFor(owner);
  assert.equal(open.length, 1);
  assert.ok(open[0].due_at);
});

test('רשימה ממספרת, ותשובה במספר מסמנת בוצע', async () => {
  await handleMessage(owner, 'להתקשר למוסך', deps);
  const list = await handleMessage(owner, 'רשימה', deps);
  assert.match(list, /ארנונה/);
  assert.match(list, /מוסך/);

  const refs = await db.getRefs(owner.id);
  assert.equal(refs.length, 2);

  const done = await handleMessage(owner, '1', deps);
  assert.match(done, /✔️/);
  const open = await db.openTasksFor(owner);
  assert.equal(open.length, 1);
});

test('כפילות עוצרת ומבקשת אישור', async () => {
  await handleMessage(owner, 'לקנות חלב', deps);
  const dup = await handleMessage(owner, 'לקנות חלב', deps);
  assert.match(dup, /יש כבר משימה כמעט זהה/);

  const before = (await db.openTasksFor(owner)).length;
  const no = await handleMessage(owner, 'לא', deps);
  assert.match(no, /לא הוספתי/);
  assert.equal((await db.openTasksFor(owner)).length, before);

  await handleMessage(owner, 'לקנות חלב', deps);
  const yes = await handleMessage(owner, 'כן', deps);
  assert.match(yes, /✅/);
  assert.equal((await db.openTasksFor(owner)).length, before + 1);
});

test('משימה משותפת מגיעה גם לצד השני', async () => {
  sent.length = 0;
  const reply = await handleMessage(owner, 'משותף — להזמין מסעדה ליום שישי', deps);
  assert.match(reply, /👥/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'partner');
  assert.match(sent[0].text, /מסעדה/);

  // אצל בת הזוג מופיעה רק הרשימה המשותפת
  const hers = await db.openTasksFor(partner);
  assert.equal(hers.length, 1);
  assert.match(hers[0].title, /מסעדה/);
});

test('משימה שבת הזוג מוסיפה נכנסת אוטומטית למשותף', async () => {
  sent.length = 0;
  await handleMessage(partner, 'לאסוף את הילדים ביום ראשון', deps);
  const hers = await db.openTasksFor(partner);
  assert.equal(hers.length, 2);
  assert.ok(hers.every((t) => t.shared));
  assert.equal(sent[0].to, 'owner');

  const mine = await db.openTasksFor(owner);
  assert.ok(mine.some((t) => /ילדים/.test(t.title)));
});

test('דחייה ומחיקה', async () => {
  await handleMessage(owner, 'רשימה', deps);
  const refs = await db.getRefs(owner.id);
  const n = refs[0].n;

  const snoozed = await handleMessage(owner, `דחה ${n} לשבוע הבא`, deps);
  assert.match(snoozed, /🕗/);

  const deleted = await handleMessage(owner, `מחק ${n}`, deps);
  assert.match(deleted, /🗑️/);

  const undo = await handleMessage(owner, 'ביטול', deps);
  assert.match(undo, /↩️/);
});

test('סיכום הבוקר נבנה בלי שגיאות וכולל את כל המקטעים', async () => {
  await handleMessage(owner, 'לחדש ביטוח באיחור', deps);
  const tasks = await db.openTasksFor(owner);
  const view = R.renderDigest(owner, tasks, { partnerName: 'איה' });
  assert.match(view.text, /בוקר טוב, אבישי/);
  assert.equal(view.order.length > 0, true);
  // כל משימה מופיעה בדיוק פעם אחת ברשימה הממוספרת
  assert.equal(new Set(view.order).size, view.order.length);
});

test('משימה חוזרת נקבעת מחדש אחרי שסומנה', async () => {
  const reply = await handleMessage(owner, 'להוציא את הכלב כל יום ב-7 בבוקר', deps);
  assert.match(reply, /🔁/);
  await handleMessage(owner, 'רשימה', deps);
  const refs = await db.getRefs(owner.id);
  const tasks = await Promise.all(refs.map((r) => db.getTask(r.task_id)));
  const dogRef = refs[tasks.findIndex((t) => /כלב/.test(t.title))];
  const done = await handleMessage(owner, String(dogRef.n), deps);
  assert.match(done, /🔁/);
  const open = await db.openTasksFor(owner);
  assert.equal(open.filter((t) => /כלב/.test(t.title)).length, 1);   // נוצרה מופע חדש
});

test('עזרה נשלחת בלי לשבור כלום', async () => {
  const help = await handleMessage(owner, 'עזרה', deps);
  assert.match(help, /איך מדברים איתי/);
  assert.match(help, /איה/);
});
