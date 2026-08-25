// זימונים ביומן — כולל המצב שבו היומן לא מחובר,
// שבו הפיצ'ר חייב עדיין להיות שימושי.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-db.js';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.LLM_PROVIDER = 'none';
delete process.env.GOOGLE_REFRESH_TOKEN;      // בבדיקות היומן לא מחובר

const db = await import('../src/db.js');
db.__setClientForTests(createFakeSupabase());
const CAL = await import('../src/calendar.js');
const R = await import('../src/render.js');
const { handleMessage } = await import('../src/brain.js');
const { makeIL } = await import('../src/util.js');

let owner;
const deps = { partnerOf: () => null, notify: async () => {}, users: () => [owner] };

test('הקמה', async () => {
  owner = await db.upsertUser('owner', { name: 'אבי', role: 'owner', sees_own_tasks: true });
  await db.setSetting('calendar_guest_aliases', { 'איה': 'ayaokshus@gmail.com' });
  assert.equal(CAL.isConnected(), false, 'היומן לא מחובר בבדיקות');
});

test('כינוי לאורח מתורגם לכתובת מייל', async () => {
  const { emails, unknown } = await CAL.resolveGuests(['איה']);
  assert.deepEqual(emails, ['ayaokshus@gmail.com']);
  assert.equal(unknown.length, 0);

  const direct = await CAL.resolveGuests(['someone@example.com']);
  assert.deepEqual(direct.emails, ['someone@example.com']);

  const miss = await CAL.resolveGuests(['דני']);
  assert.deepEqual(miss.emails, []);
  assert.deepEqual(miss.unknown, ['דני']);
});

test('קישור ליומן מכיל כותרת, זמן ואורחים', () => {
  const start = makeIL(2026, 9, 20, 14, 0);
  const link = CAL.eventLink({
    title: 'פגישה עם רואה חשבון',
    start,
    end: new Date(start.getTime() + 3600e3),
    guests: ['ayaokshus@gmail.com'],
    location: 'רוטשילד 1',
  });
  assert.match(link, /calendar\.google\.com/);
  assert.match(link, /action=TEMPLATE/);
  assert.match(link, /add=ayaokshus/);
  assert.match(link, /dates=\d{8}T\d{6}Z%2F\d{8}T\d{6}Z/);
  assert.match(link, /ctz=Asia%2FJerusalem/);
});

test('אירוע יום שלם — טווח של יום אחד, בלי שעות', () => {
  const link = CAL.eventLink({ title: 'ביקור אצל ההורים', start: makeIL(2026, 9, 20, 0, 0), allDay: true });
  const dates = /dates=(\d{8})%2F(\d{8})/.exec(link);
  assert.ok(dates, 'תאריכים בפורמט יום שלם');
  assert.notEqual(dates[1], dates[2], 'יום סיום הוא היום שאחרי');
});

test('בלי חיבור ליומן — נשמר ומוחזר קישור, לא שגיאה', async () => {
  const start = makeIL(2026, 9, 20, 14, 0);
  const ev = await db.createCalendarEvent({
    title: 'פגישה עם רו״ח', starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 3600e3).toISOString(),
    all_day: false, guests: ['ayaokshus@gmail.com'],
    status: 'link_only', created_by: owner.id,
  });
  const out = R.renderEventLink(ev, CAL.eventLink({ title: ev.title, start, guests: ev.guests }));
  assert.match(out, /מוכן ליומן/);
  assert.match(out, /calendar\.google\.com/);
  assert.match(out, /רו״ח/);
});

test('"זימונים" מציג את מה שנוצר, וביטול מסמן כמבוטל', async () => {
  const list = await handleMessage(owner, 'זימונים', deps);
  assert.match(list, /פגישה עם רו״ח/);

  const cancelled = await handleMessage(owner, 'תבטל את הזימון', deps);
  assert.match(cancelled, /בוטל/);

  const after = await db.liveCalendarEvents(owner.id);
  assert.equal(after.some((e) => /רו״ח/.test(e.title)), false, 'לא מופיע יותר ברשימה');
});

test('זימון לא מופיע ברשימת המשימות', async () => {
  const tasks = await db.openTasksFor(owner);
  assert.equal(tasks.some((t) => /רו״ח/.test(t.title)), false);
});
