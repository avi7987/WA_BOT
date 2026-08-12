// בודק את מסלול ה-AI בלי לגעת ברשת: מחליף את fetch בתשובה מוכנה
// בפורמט של Gemini, ומוודא שהפעולות שחוזרות באמת מבוצעות.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-db.js';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.LLM_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'fake-key';

const db = await import('../src/db.js');
db.__setClientForTests(createFakeSupabase());
const llm = await import('../src/llm.js');
const { handleMessage } = await import('../src/brain.js');

// ── fetch מזויף ─────────────────────────────────────────────────────
let nextBody = null;
let lastRequest = null;
globalThis.fetch = async (url, opts) => {
  lastRequest = { url: String(url), body: JSON.parse(opts.body) };
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: nextBody }] } }] }),
    text: async () => nextBody,
  };
};

const gemini = (obj) => { nextBody = JSON.stringify(obj); };

let user;
const deps = { partnerOf: () => null, notify: async () => {} };

test('הקמה', async () => {
  user = await db.upsertUser('owner', { name: 'אבישי', role: 'owner', sees_own_tasks: true });
  assert.ok(llm.textAvailable());
});

test('הודעה אחת עם שתי משימות → שתיהן נוצרות', async () => {
  gemini({
    actions: [
      { type: 'add', title: 'לשלם ארנונה', due: '2026-09-20T09:00:00+03:00', all_day: true, shared: false },
      { type: 'add', title: 'להזמין מתנה לאמא', due: null, all_day: true, shared: false },
    ],
    reply: null,
  });
  const reply = await handleMessage(user, 'צריך לשלם ארנונה עד ה-20 וגם להזמין מתנה לאמא', deps);
  assert.match(reply, /נוספו 2 משימות/);
  const open = await db.openTasksFor(user);
  assert.equal(open.length, 2);
  assert.ok(open.some((t) => t.title === 'לשלם ארנונה' && t.due_at));
});

test('הרשימה שנשלחת ל-AI ממוספרת כמו שהמשתמש רואה', async () => {
  gemini({ actions: [{ type: 'none' }], reply: 'בסדר' });
  await handleMessage(user, 'סתם משהו', deps);
  const promptText = lastRequest.body.systemInstruction.parts[0].text;
  assert.match(promptText, /1\. /);
  assert.match(promptText, /לשלם ארנונה/);

  const refs = await db.getRefs(user.id);
  assert.equal(refs.length, 2);
});

test('"סיימתי עם הארנונה" → סימון בוצע לפי מספר', async () => {
  const refs = await db.getRefs(user.id);
  const t = await db.getTask(refs[0].task_id);
  gemini({ actions: [{ type: 'complete', ref: refs[0].n }], reply: null });
  const reply = await handleMessage(user, `סיימתי עם ${t.title}`, deps);
  assert.match(reply, /✔️/);
  assert.equal((await db.openTasksFor(user)).length, 1);
});

test('התייחסות לפי שם משימה ולא לפי מספר', async () => {
  gemini({ actions: [{ type: 'complete', ref: 'מתנה לאמא' }], reply: null });
  const reply = await handleMessage(user, 'קניתי את המתנה', deps);
  assert.match(reply, /✔️/);
  assert.equal((await db.openTasksFor(user)).length, 0);
});

test('תשובה עטופה ב-```json עדיין נקראת', async () => {
  nextBody = '```json\n{"actions":[{"type":"add","title":"לבדוק ביטוח","due":null,"all_day":true}],"reply":null}\n```';
  const reply = await handleMessage(user, 'לבדוק ביטוח', deps);
  assert.match(reply, /ביטוח/);
});

test('AI שנופל — נופלים לפרסר המקומי ולא מאבדים את המשימה', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const reply = await handleMessage(user, 'להתקשר למוסך מחר', deps);
  assert.match(reply, /מוסך/);
  const open = await db.openTasksFor(user);
  assert.ok(open.some((t) => /מוסך/.test(t.title) && t.due_at));
});
