// תיבת הרעיונות — ובעיקר: שהיא לא מזהמת את רשימת המשימות.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-db.js';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.LLM_PROVIDER = 'none';

const db = await import('../src/db.js');
db.__setClientForTests(createFakeSupabase());
const R = await import('../src/render.js');
const { handleMessage } = await import('../src/brain.js');

let owner;
const deps = { partnerOf: () => null, notify: async () => {}, users: () => [owner] };

test('הקמה', async () => {
  owner = await db.upsertUser('owner', { name: 'אבי', role: 'owner', sees_own_tasks: true });
  assert.ok(owner.id);
});

test('"רעיון: ..." נשמר בתיבה ולא כמשימה', async () => {
  const reply = await handleMessage(owner, 'רעיון: תוסיף אפשרות לצרף תמונות למשימה', deps);
  assert.match(reply, /💡/);
  assert.match(reply, /תמונות/);

  const reqs = await db.openRequests();
  assert.equal(reqs.length, 1);
  assert.match(reqs[0].body, /תמונות/);

  const tasks = await db.openTasksFor(owner);
  assert.equal(tasks.length, 0, 'לא נוצרה משימה');
});

test('הרעיונות לא מופיעים בסיכום הבוקר ולא ברשימת המשימות', async () => {
  await handleMessage(owner, 'לשלם ארנונה מחר', deps);
  const tasks = await db.openTasksFor(owner);

  const digest = R.renderDigest(owner, tasks, {});
  assert.equal(/תמונות/.test(digest.text), false, 'לא בסיכום הבוקר');

  const all = await handleMessage(owner, 'הכל', deps);
  assert.equal(/תמונות/.test(all), false, 'לא ברשימת המשימות');
});

test('"רעיונות" מציג את התיבה', async () => {
  await handleMessage(owner, 'באג: התזכורת הגיעה פעמיים', deps);
  const view = await handleMessage(owner, 'רעיונות', deps);
  assert.match(view, /תיבת הרעיונות/);
  assert.match(view, /תמונות/);
  assert.match(view, /פעמיים/);

  const refs = await db.resolveRequestRef(owner.id, 1);
  assert.ok(refs, 'נשמרו מספרי קיצור לרעיונות');
});

test('מספרי הרעיונות לא דורסים את מספרי המשימות', async () => {
  await handleMessage(owner, 'רשימה', deps);
  const taskRefs = await db.getRefs(owner.id);
  await handleMessage(owner, 'רעיונות', deps);
  const after = await db.getRefs(owner.id);
  assert.deepEqual(after.map((r) => r.n), taskRefs.map((r) => r.n), 'מספרי המשימות לא השתנו');
});

test('סימון רעיון כבוצע מוציא אותו מהתיבה', async () => {
  await handleMessage(owner, 'רעיונות', deps);
  const before = (await db.openRequests()).length;
  const reply = await handleMessage(owner, 'רעיון בוצע 1', deps);
  assert.match(reply, /✅/);
  assert.equal((await db.openRequests()).length, before - 1);
});

test('כמה ניסוחים לפתיחת רעיון', async () => {
  for (const prefix of ['רעיון', 'בקשה', 'הצעה', 'באג']) {
    const before = (await db.openRequests()).length;
    await handleMessage(owner, `${prefix}: משהו לבדוק ${prefix}`, deps);
    assert.equal((await db.openRequests()).length, before + 1, prefix);
  }
});
