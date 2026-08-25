// רשימות ייחוס — והשאלה החשובה ביותר עליהן:
// האם הן נשארות מחוץ לרשימת המשימות ולסיכום הבוקר?
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-db.js';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.LLM_PROVIDER = 'none';

const db = await import('../src/db.js');
db.__setClientForTests(createFakeSupabase());
const L = await import('../src/lists.js');
const R = await import('../src/render.js');
const { handleMessage } = await import('../src/brain.js');

let owner, food;
const deps = { partnerOf: () => null, notify: async () => {}, users: () => [owner] };

test('הקמה', async () => {
  owner = await db.upsertUser('owner', { name: 'אבי', role: 'owner', sees_own_tasks: true });
  food = await db.createList({
    name: 'מסעדות ובתי קפה',
    aliases: ['מסעדות', 'בתי קפה', 'קפה', 'אוכל'],
    icon: '🍽️', shared: true, owner_id: owner.id,
  });
  assert.ok(food.id);
});

test('זיהוי הרשימה לפי שם או כינוי', async () => {
  assert.equal((await L.findList('מסעדות'))?.id, food.id);
  assert.equal((await L.findList('בתי קפה'))?.id, food.id);
  assert.equal((await L.findList('אוכל'))?.id, food.id);
  assert.equal(await L.findList('ספרים'), null);
});

test('הוספת מקום עם מיקום ותגיות', async () => {
  const reply = await handleMessage(owner, 'תוסיף למסעדות: קפה איטליה, פלורנטין תל אביב, בשרי', deps);
  assert.match(reply, /קפה איטליה/);
  const items = await db.listItems(food.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'קפה איטליה');
  assert.equal(items[0].location_text, 'פלורנטין תל אביב');
  assert.equal(items[0].area, 'תל אביב', 'האזור חולץ מהמיקום החופשי');
  assert.deepEqual(items[0].tags, ['בשרי']);
});

test('הרשימה לא מופיעה במשימות ולא בסיכום הבוקר', async () => {
  const openTasks = await db.openTasksFor(owner);
  assert.equal(openTasks.some((t) => /קפה איטליה/.test(t.title)), false, 'לא נכנס למשימות');

  const digest = R.renderDigest(owner, openTasks, {});
  assert.equal(/קפה איטליה/.test(digest.text), false, 'לא מופיע בסיכום הבוקר');

  const all = await handleMessage(owner, 'הכל', deps);
  assert.equal(/קפה איטליה/.test(all), false, 'לא מופיע ב"כל המשימות"');
});

test('פתיחת הרשימה בשמה, וסינון לפי אזור', async () => {
  await L.addItem(owner, food, { title: 'מיזו', location: 'נמל תל אביב', tags: ['סושי'] });
  await L.addItem(owner, food, { title: 'אומאמי', location: 'כרמיאל' });

  const shown = await handleMessage(owner, 'מסעדות', deps);
  assert.match(shown, /קפה איטליה/);
  assert.match(shown, /אומאמי/);

  const tlv = await handleMessage(owner, 'מסעדות בתל אביב', deps);
  assert.match(tlv, /קפה איטליה/);
  assert.match(tlv, /מיזו/);
  assert.equal(/אומאמי/.test(tlv), false, 'כרמיאל אינה תל אביב');
});

test('"בצפון" תופס גם ערים בצפון', async () => {
  const north = await L.search(food, { area: 'צפון' });
  assert.ok(north.some((i) => i.title === 'אומאמי'), 'כרמיאל נחשבת צפון');
  assert.equal(north.some((i) => i.title === 'מיזו'), false);
});

test('מספרי הרשימה לא דורסים את מספרי המשימות', async () => {
  await handleMessage(owner, 'לשלם ארנונה מחר', deps);
  await handleMessage(owner, 'רשימה', deps);
  const taskRefs = await db.getRefs(owner.id);
  assert.ok(taskRefs.length, 'יש מספרי משימות');

  await handleMessage(owner, 'מסעדות', deps);           // מציג רשימת ייחוס
  const stillThere = await db.getRefs(owner.id);
  assert.deepEqual(stillThere.map((r) => r.n), taskRefs.map((r) => r.n), 'מספרי המשימות לא השתנו');

  const itemRef = await db.resolveItemRef(owner.id, 1);
  assert.ok(itemRef, 'יש מרחב מספרים נפרד לפריטי הרשימה');
  assert.notEqual(itemRef.item_id, taskRefs[0].task_id);
});

test('מחיקת פריט מהרשימה', async () => {
  await handleMessage(owner, 'מסעדות', deps);
  const before = (await db.listItems(food.id)).length;
  const reply = await handleMessage(owner, 'תמחק מהמסעדות 1', deps);
  assert.match(reply, /🗑️/);
  assert.equal((await db.listItems(food.id)).length, before - 1);
});

test('כפילות מזוהה', async () => {
  await L.addItem(owner, food, { title: 'פרש קיטשן', location: 'רוטשילד' });
  const again = await L.addItem(owner, food, { title: 'פרש קיטשן', location: 'רוטשילד' });
  assert.ok(again.duplicate, 'לא נוסף פעמיים');
});

test('פתיחת רשימה חדשה', async () => {
  const reply = await handleMessage(owner, 'תפתח רשימה של ספרים', deps);
  assert.match(reply, /ספרים/);
  assert.ok(await L.findList('ספרים'));
});
