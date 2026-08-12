// =====================================================================
//  scheduler.js — כל מה שהבוט שולח מיוזמתו:
//    • סיכום הבוקר בשעה שנקבעה (ברירת מחדל 08:00)
//    • תזכורת בשעת היעד למשימות עם שעה מדויקת
//    • סיכום ערב קצר (אופציונלי)
//  רץ כל דקה, ומכבד את חלון השעות ב-.env.
// =====================================================================
import * as db from './db.js';
import * as R from './render.js';
import { ilMinutesNow, hhmmToMinutes, withinQuietWindow, daysFromToday } from './util.js';

const TICK_MS = 60_000;
const DIGEST_GRACE_MIN = 120;      // אם השרת עלה מאוחר — עדיין שולחים, עד שעתיים אחרי

let started = false;

/**
 * deps = { users() -> [user], sendTo(user, text) -> Promise, partnerOf(user) }
 */
export function startScheduler(deps) {
  if (started) return;
  started = true;
  console.log('⏰ המתזמן פועל (סיכום בוקר + תזכורות).');
  tick(deps);
  setInterval(() => tick(deps), TICK_MS);
}

async function tick(deps) {
  try {
    const users = deps.users();
    if (!users.length) return;
    for (const user of users) {
      await maybeDigest(user, deps, 'morning');
      if (user.evening_digest || String(process.env.EVENING_DIGEST) === 'true') {
        await maybeDigest(user, deps, 'evening');
      }
    }
    await runReminders(deps);
  } catch (e) {
    console.error('מתזמן:', e.message || e);
  }
}

// ── סיכום יומי ──────────────────────────────────────────────────────
async function maybeDigest(user, deps, when) {
  const target = when === 'morning'
    ? hhmmToMinutes(user.digest_time || process.env.DIGEST_TIME || '08:00', 8 * 60)
    : hhmmToMinutes(process.env.EVENING_TIME || '21:00', 21 * 60);

  const now = ilMinutesNow();
  if (now < target || now > target + DIGEST_GRACE_MIN) return;

  const kind = when === 'morning' ? 'digest_morning' : 'digest_evening';
  const first = await db.claimDaily(user.id, kind);
  if (!first) return;                       // כבר נשלח היום

  const tasks = await db.openTasksFor(user);
  // בערב לא מציפים כשאין כלום
  if (when === 'evening' && !tasks.some((t) => t.due_at && daysFromToday(new Date(t.due_at)) <= 0)) return;

  const partner = deps.partnerOf(user);
  const view = R.renderDigest(user, tasks, { partnerName: partner?.name, evening: when === 'evening' });
  await db.setRefs(user.id, view.order);
  await deps.sendTo(user, view.text);
  console.log(`📤 סיכום ${when === 'morning' ? 'בוקר' : 'ערב'} נשלח ל-${user.name}`);
}

// ── תזכורות בשעת היעד ───────────────────────────────────────────────
async function runReminders(deps) {
  if (!withinQuietWindow()) return;

  const tasks = await db.allOpenTasks();
  const now = Date.now();
  const users = deps.users();
  const byId = new Map(users.map((u) => [u.id, u]));

  for (const t of tasks) {
    if (!t.due_at || t.all_day || t.remind_sent_at) continue;
    const due = new Date(t.due_at).getTime();
    if (due > now) continue;                    // עוד לא הגיע הזמן
    if (now - due > 30 * 60e3) {                // עבר יותר מחצי שעה — לא מציקים באיחור
      await db.updateTask(t.id, { remind_sent_at: new Date().toISOString() });
      continue;
    }

    const targets = [];
    const owner = byId.get(t.owner_id);
    if (owner) targets.push(owner);
    if (t.shared) {
      for (const u of users) if (u.id !== t.owner_id && !targets.includes(u)) targets.push(u);
    }
    if (!targets.length) continue;

    await db.updateTask(t.id, { remind_sent_at: new Date().toISOString() });
    for (const u of targets) {
      try { await deps.sendTo(u, R.renderReminder(t)); } catch (e) { console.error('תזכורת:', e.message); }
    }
    console.log(`⏰ תזכורת נשלחה: ${t.title}`);
  }
}
