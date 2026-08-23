// בדיקות להודעות יוצאות — החלק שבו טעות היא בלתי הפיכה.
// כל בדיקה כאן שואלת את אותה שאלה: האם משהו יכול לצאת בלי אישור?
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-db.js';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.LLM_PROVIDER = 'none';
process.env.QUIET_START = '00:00';        // בבדיקות אין שעות שקט
process.env.QUIET_END = '23:59';

const db = await import('../src/db.js');
db.__setClientForTests(createFakeSupabase());
const OB = await import('../src/outbound.js');
const T = await import('../src/tasks.js');
const R = await import('../src/render.js');
const { handleMessage } = await import('../src/brain.js');

let owner, task;
const sentToWhatsApp = [];    // מה יצא בפועל אל העולם
const sentToMe = [];          // מה הבוט כתב לי

const deps = {
  partnerOf: () => null,
  notify: async () => {},
  users: () => [owner],
  sendTo: async (u, text) => { sentToMe.push(text); },
  sendToContact: async (u, phone, text) => { sentToWhatsApp.push({ phone, text }); },
  findContacts: async () => [],
};

let phoneSeq = 0;
// מספר שונה לכל בדיקה — אחרת מעקה מניעת הכפילות (10 דקות) חוסם אותן,
// וזה בדיוק מה שהוא אמור לעשות.
const draft = async (body = 'היי יוסי, אפשר לקבוע לשבוע הבא?') =>
  OB.compose(owner, { taskId: task.id, phone: '05412345' + String(60 + (++phoneSeq)).slice(-2), name: 'יוסי אינסטלטור', body });

test('הקמה', async () => {
  owner = await db.upsertUser('owner', { name: 'אבי', role: 'owner', sees_own_tasks: true });
  task = (await T.addTask(owner, { title: 'לתאם תיקון נזילה', source_text: 't' })).task;
  assert.ok(owner.id && task.id);
});

test('יצירה שומרת את הטקסט מילה במילה, ולא שולחת כלום', async () => {
  const body = 'היי יוסי, אפשר לקבוע לשבוע הבא?';
  const m = await draft(body);
  assert.equal(m.body, body, 'הטקסט לא נוסח מחדש');
  assert.match(m.to_phone, /^97254123456[0-9]$/);
  assert.equal(m.status, 'draft');
  assert.equal(sentToWhatsApp.length, 0, 'שום דבר לא יצא');
});

test('כרטיס האישור מציג שם, מספר מלא, וטקסט מדויק', async () => {
  const m = await draft();
  const card = R.renderApprovalRequest(m, task);
  assert.match(card, /יוסי אינסטלטור/);
  assert.match(card, /054-[0-9]{3}-[0-9]{4}/, 'המספר המלא מוצג — כך תופסים נמען שגוי');
  assert.match(card, /אפשר לקבוע לשבוע הבא/);
  assert.match(card, /1 = שלח/);
});

test('אישור במספר 1 שולח, מתעד, ומסמן כנשלחה', async () => {
  sentToWhatsApp.length = 0;
  const m = await draft('בדיקה אחת');
  await OB.askApproval(owner, m, deps);

  const reply = await handleMessage(owner, '1', deps);
  assert.match(reply, /✅/);
  assert.equal(sentToWhatsApp.length, 1);
  assert.equal(sentToWhatsApp[0].text, 'בדיקה אחת', 'נשלח בדיוק מה שאושר');
  assert.match(sentToWhatsApp[0].phone, /^97254123456[0-9]$/);

  const after = await db.getMessage(m.id);
  assert.equal(after.status, 'sent');
  assert.equal(after.approved_by, owner.id);
  assert.equal((await db.sentToday()).length >= 1, true, 'נרשם ביומן');
});

test('תשובה 3 מבטלת — ושום דבר לא יוצא', async () => {
  sentToWhatsApp.length = 0;
  const m = await draft('לא לשלוח');
  await OB.askApproval(owner, m, deps);
  const reply = await handleMessage(owner, '3', deps);
  assert.match(reply, /בוטלה/);
  assert.equal(sentToWhatsApp.length, 0);
  assert.equal((await db.getMessage(m.id)).status, 'cancelled');
});

test('שתיקה אינה אישור — הודעה פגה וחוזרת לטיוטה', async () => {
  sentToWhatsApp.length = 0;
  const m = await draft('הודעה נשכחת');
  await OB.askApproval(owner, m, deps);
  // מזייפים המתנה של 7 שעות
  await db.updateMessage(m.id, { asked_at: new Date(Date.now() - 7 * 3600e3).toISOString() });

  await OB.runOutbound(deps);

  const after = await db.getMessage(m.id);
  assert.equal(after.status, 'draft', 'חזרה לטיוטה');
  assert.equal(sentToWhatsApp.length, 0, 'לא נשלחה');
  assert.ok(sentToMe.some((t) => /לא נשלחה/.test(t)), 'הודיע לי');
});

test('עריכה מאפסת אישור — הנוסח החדש חייב אישור משלו', async () => {
  const m = await draft('נוסח ראשון');
  await OB.askApproval(owner, m, deps);
  const edited = await OB.edit(owner, m.id, 'נוסח שני');
  assert.equal(edited.body, 'נוסח שני');
  assert.equal(edited.status, 'draft');
  assert.equal(edited.approved_at, null);
});

test('תקרה יומית עוצרת שליחה', async () => {
  sentToWhatsApp.length = 0;
  await db.setSetting('outbound_daily_cap', 1);
  const m = await draft('מעבר לתקרה');
  await OB.askApproval(owner, m, deps);
  const reply = await OB.approveAndSend(owner, m.id, deps);
  assert.match(reply, /תקרה/);
  assert.equal(sentToWhatsApp.length, 0);
  await db.setSetting('outbound_daily_cap', 20);
});

test('כשל בשליחה לא מסמן כנשלחה', async () => {
  const m = await draft('ייכשל');
  const failing = { ...deps, sendToContact: async () => { throw new Error('אין רשת'); } };
  const reply = await OB.approveAndSend(owner, m.id, failing);
  assert.match(reply, /נכשלה/);
  const after = await db.getMessage(m.id);
  assert.equal(after.status, 'draft');
  assert.match(after.last_error, /אין רשת/);
});

test('מספר לא תקין נחסם ביצירה', async () => {
  await assert.rejects(
    () => OB.compose(owner, { taskId: task.id, phone: '123', body: 'שלום' }),
    /לא תקין/,
  );
});

test('משימה עם הודעה מקבלת סימון 📤', async () => {
  const counts = await db.messageCounts([task.id]);
  assert.ok((counts.get(task.id) || 0) > 0);
  const line = R.renderList(owner, [{ ...task, due_at: null }], 'all', { messageCounts: counts });
  assert.match(line.text, /📤/);
});
