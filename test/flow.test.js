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
const T = await import('../src/tasks.js');

let owner, partner;
const sent = [];                           // הודעות שנשלחו לצד השני

const deps = {
  partnerOf: (u) => (u.session_key === 'owner' ? partner : owner),
  notify: async (u, text) => { sent.push({ to: u.session_key, text }); },
};

test('הקמה', async () => {
  owner = await db.upsertUser('owner', { name: 'אבי', role: 'owner', sees_own_tasks: true, default_shared: false });
  partner = await db.upsertUser('partner', { name: 'איה', role: 'member', sees_own_tasks: true, default_shared: false });
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

  const hers = await db.openTasksFor(partner);
  assert.ok(hers.some((t) => /מסעדה/.test(t.title)), "איה רואה את המשותפת");
});

test('איה כותבת בניסוח שמרמז על אבי — נכנס למשותף ומשויך אליו', async () => {
  sent.length = 0;
  await handleMessage(partner, 'שאבי יאסוף את הילדים ביום ראשון', deps);
  const hers = await db.openTasksFor(partner);
  const t = hers.find((x) => /ילדים/.test(x.title));
  assert.ok(t, 'נוצרה');
  assert.equal(t.shared, true, 'הוסק מההקשר שזה משותף, בלי המילה משותף');
  assert.equal(t.assigned_to, owner.id, 'שויכה לאבי');
  assert.equal(sent[0].to, 'owner');

  const mine = await db.openTasksFor(owner);
  assert.ok(mine.some((x) => /ילדים/.test(x.title)), 'אבי רואה אותה');
});

test('משימה שאיה כותבת סתם נשארת אישית שלה', async () => {
  await handleMessage(partner, 'לקבוע תור לספרית', deps);
  const hers = await db.openTasksFor(partner);
  const t = hers.find((x) => /ספרית/.test(x.title));
  assert.ok(t);
  assert.equal(t.shared, false);
  const mine = await db.openTasksFor(owner);
  assert.equal(mine.some((x) => /ספרית/.test(x.title)), false, 'אבי לא רואה את האישית שלה');
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
  assert.match(view.text, /בוקר טוב, אבי/);
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

// ── מודל שלושת האזורים ושיוך (גרסה 2) ──────────────────────────────
test('אזור אישי — הצד השני לא רואה ולא יכול לגעת', async () => {
  await handleMessage(owner, 'לקנות מתנה לאמא שלי', deps);
  const mine = await db.openTasksFor(owner);
  const priv = mine.find((t) => /מתנה לאמא/.test(t.title));
  assert.ok(priv, 'המשימה נוצרה אצל אבי');
  assert.equal(priv.shared, false);

  const hers = await db.openTasksFor(partner);
  assert.equal(hers.some((t) => /מתנה לאמא/.test(t.title)), false, 'איה לא רואה משימה אישית של אבי');
});

test('שיוך לצד השני נכנס למשותף ומסומן בטיפולו', async () => {
  sent.length = 0;
  const spec = { title: 'לקחת את הדואר', assigned_to: partner.id, source_text: 'test' };
  const res = await T.addTask(owner, spec);
  assert.ok(res.task, 'נוצרה');
  assert.equal(res.task.shared, true, 'שיוך גורר שיתוף אוטומטית');
  assert.equal(res.task.assigned_to, partner.id);

  const hers = await db.openTasksFor(partner);
  assert.ok(hers.some((t) => t.id === res.task.id), 'איה רואה אותה');
});

test('שיוך משנה משימה קיימת ומעביר אותה למשותף', async () => {
  const res = await T.addTask(owner, { title: 'להחליף נורה בסלון', source_text: 't' });
  assert.equal(res.task.shared, false);
  const changed = await T.setAssignee(owner, [res.task.id], partner.id);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].task.shared, true, 'הפכה למשותפת');
  assert.equal(changed[0].task.assigned_to, partner.id);
});

test('סימון משימה שכבר בוצעה מדווח מי ומתי, לא "לא מצאתי"', async () => {
  const res = await T.addTask(owner, { title: 'להזמין פיצה', shared: true, source_text: 't' });
  await T.completeTasks(partner, [res.task.id]);          // איה הקדימה
  const { done, already } = await T.completeTasks(owner, [res.task.id]);
  assert.equal(done.length, 0);
  assert.equal(already.length, 1);
  const txt = R.renderDone(done, [], { already, nameOf: (id) => (id === partner.id ? 'איה' : 'אבי') });
  assert.match(txt, /כבר סומנה/);
  assert.match(txt, /איה/);
});

test('ביטול מחזיר שיוך קודם', async () => {
  const res = await T.addTask(owner, { title: 'לתאם ביקור', shared: true, source_text: 't' });
  await T.setAssignee(owner, [res.task.id], partner.id);
  const la = await T.undoLast(owner);
  assert.equal(la.kind, 'assign');
  const after = await db.getTask(res.task.id);
  assert.equal(after.assigned_to, null);
});

// ── הערות, הבהרה ותזכורות (גרסה 2.1) ───────────────────────────────
test('הערה נשמרת, מסומנת ברשימה, ונדחפת לצד השני כשהמשימה משותפת', async () => {
  sent.length = 0;
  const due = new Date(Date.now() + 864e5).toISOString();
  // force — "לקנות חלב" כבר קיימת מבדיקת הכפילויות, וזיהוי הכפילות היה חוסם
  const res = await T.addTask(owner, { title: 'לקנות חלב ולחם', shared: true, due_at: due, source_text: 't' }, { force: true });
  assert.ok(res.task);

  const numOf = async (re) => {
    await handleMessage(owner, 'רשימה', deps);
    const refs = await db.getRefs(owner.id);
    const tasks = await Promise.all(refs.map((r) => db.getTask(r.task_id)));
    const i = tasks.findIndex((t) => re.test(t.title));
    assert.ok(i >= 0, 'המשימה מופיעה ברשימה');
    return refs[i].n;
  };

  const reply = await handleMessage(owner, `הערה ${await numOf(/חלב ולחם/)}: כבר קניתי חלב, צריך רק לחם`, deps);
  assert.match(reply, /💬/);

  // נדחפה מיד לאיה, ולא נשארה מחכה שתשים לב לסימון
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'partner');
  assert.match(sent[0].text, /כבר קניתי חלב/);

  // מופיעה כסימון ברשימה
  const list = await handleMessage(owner, 'רשימה', deps);
  assert.match(list, /💬/);

  // ואפשר לשלוף אותה
  const notes = await handleMessage(owner, `הערות ${await numOf(/חלב ולחם/)}`, deps);
  assert.match(notes, /כבר קניתי חלב/);
});

test('שתי משימות דומות → שאלת הבהרה, ותשובה במספר בוחרת', async () => {
  const a = await T.addTask(owner, { title: 'פגישה עם רואה חשבון בבנק', source_text: 't' });
  const b = await T.addTask(owner, { title: 'פגישה עם רואה חשבון במשרד', source_text: 't' }, { force: true });
  assert.ok(a.task && b.task);

  const r = await T.resolveRefs(owner, ['פגישה עם רואה חשבון']);
  assert.equal(r.ids.length, 0, 'לא ניחש');
  assert.ok(r.ambiguous.length, 'זוהתה עמימות');
  assert.ok(r.ambiguous[0].candidates.length >= 2);

  const q = R.renderDisambiguation(r.ambiguous[0].query, r.ambiguous[0].candidates);
  assert.match(q, /על איזו התכוונת/);
  assert.match(q, /1 ·/);

  // מסלול מלא: השאלה נשמרת, והתשובה במספר מבצעת את הפעולה על הנבחרת
  await db.setState(owner.id, {
    pending: { kind: 'disambiguate', verb: 'complete', payload: {},
               query: 'פגישה', ids: r.ambiguous[0].candidates.map((t) => t.id),
               expires_at: Date.now() + 60e3 },
  });
  const picked = await handleMessage(owner, '2', deps);
  assert.match(picked, /✔️/);
  const after = await db.getTask(r.ambiguous[0].candidates[1].id);
  assert.equal(after.status, 'done');
});

test('תזכורת מציגה אפשרויות ממוספרות', () => {
  const t = { title: 'פגישה עם רו״ח', due_at: new Date(Date.now() + 15 * 60e3).toISOString(), all_day: false };
  const txt = R.renderReminder(t, { leadMinutes: 15 });
  assert.match(txt, /⏰/);
  assert.match(txt, /1 = בוצע/);
  assert.match(txt, /2 = דחה בשעה/);
  assert.match(txt, /3 = דחה למחר/);
});

test('תשובה 1 על תזכורת מסמנת את אותה משימה כבוצעה', async () => {
  const res = await T.addTask(owner, { title: 'להתקשר לביטוח', source_text: 't' });
  await db.setState(owner.id, {
    pending: { kind: 'reminder_actions', task_id: res.task.id, expires_at: Date.now() + 60e3 },
  });
  const reply = await handleMessage(owner, '1', deps);
  assert.match(reply, /✔️/);
  const after = await db.getTask(res.task.id);
  assert.equal(after.status, 'done');
});

test('תשובה 3 על תזכורת דוחה למחר', async () => {
  const res = await T.addTask(owner, { title: 'לשלוח מסמכים', source_text: 't' });
  await db.setState(owner.id, {
    pending: { kind: 'reminder_actions', task_id: res.task.id, expires_at: Date.now() + 60e3 },
  });
  const reply = await handleMessage(owner, '3', deps);
  assert.match(reply, /🕗/);
  const after = await db.getTask(res.task.id);
  assert.equal(after.status, 'open');
  assert.ok(new Date(after.due_at).getTime() > Date.now());
});
