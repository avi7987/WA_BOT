// =====================================================================
//  outbound.js — הודעות יוצאות לאנשים אחרים, מקושרות למשימה.
//
//  זהו החלק המסוכן ביותר במערכת: הודעה שיוצאת לאדם אחר היא בלתי
//  הפיכה, ושליחה אוטומטית לאנשים שלא כתבו לך היא הדפוס שגורם
//  לחסימת מספרים. לכן כל ההיגיון כאן בנוי סביב עיקרון אחד:
//
//      שום הודעה לא יוצאת בלי אישור אנושי מפורש, פר-הודעה.
//      שתיקה לעולם אינה אישור.
//
//  המעקות (תקרה יומית, שעות שקט, מניעת כפילות) אינם ניתנים לכיבוי
//  מתוך הצ'אט — רק בקוד. זה מכוון.
// =====================================================================
import * as db from './db.js';
import * as R from './render.js';
import { withinQuietWindow, normPhone } from './util.js';

const DEFAULTS = { dailyCap: 20, expiryHours: 6, dedupeMinutes: 10 };

async function limits() {
  return {
    dailyCap: Number(await db.getSetting('outbound_daily_cap', DEFAULTS.dailyCap)) || DEFAULTS.dailyCap,
    expiryHours: Number(await db.getSetting('outbound_expiry_hours', DEFAULTS.expiryHours)) || DEFAULTS.expiryHours,
    dedupeMinutes: Number(await db.getSetting('outbound_dedupe_minutes', DEFAULTS.dedupeMinutes)) || DEFAULTS.dedupeMinutes,
  };
}

// ── יצירה ───────────────────────────────────────────────────────────
export async function compose(user, { taskId, phone, name, body, sendAt }) {
  const to = normPhone(phone);
  if (!to || to.length < 11) throw new Error('מספר הנמען לא תקין');
  if (!body || !body.trim()) throw new Error('אין תוכן להודעה');

  return db.createMessage({
    task_id: taskId,
    to_phone: to,
    to_name: name || null,
    body: body.trim(),                 // בדיוק כפי שהוכתב — בלי ניסוח מחדש
    status: sendAt ? 'scheduled' : 'draft',
    send_at: sendAt || null,
    created_by: user.id,
  });
}

export async function edit(user, msgId, body) {
  if (!body || !body.trim()) throw new Error('אין תוכן להודעה');
  // עריכה מבטלת אישור קודם — הטקסט החדש חייב אישור משלו
  return db.updateMessage(msgId, {
    body: body.trim(),
    status: 'draft',
    approved_by: null, approved_at: null, asked_at: null,
  });
}

export async function cancel(user, msgId) {
  return db.updateMessage(msgId, { status: 'cancelled' });
}

// ── בקשת אישור ──────────────────────────────────────────────────────
/**
 * מציג את ההודעה למשתמש ומעביר אותה למצב "ממתינה לאישור".
 * שומר הקשר קצר-מועד כך ש-1/2/3/4 בתשובה מתייחסים אליה.
 */
export async function askApproval(user, msg, deps) {
  const task = await db.getTask(msg.task_id);
  await db.updateMessage(msg.id, { status: 'awaiting_approval', asked_at: new Date().toISOString() });
  await db.setState(user.id, {
    pending: { kind: 'approve_message', message_id: msg.id, expires_at: Date.now() + 6 * 3600e3 },
  });
  await deps.sendTo(user, R.renderApprovalRequest(msg, task));
}

// ── שליחה בפועל ─────────────────────────────────────────────────────
/**
 * מבצע את השליחה אחרי אישור. בודק את כל המעקות לפני.
 * מחזיר טקסט תשובה למשתמש.
 */
export async function approveAndSend(user, msgId, deps) {
  const msg = await db.getMessage(msgId);
  if (!msg) return 'לא מצאתי את ההודעה.';
  if (msg.status === 'sent') return 'ההודעה כבר נשלחה.';
  if (msg.status === 'cancelled') return 'ההודעה בוטלה קודם לכן.';

  const lim = await limits();

  // מעקה 1 — שעות שקט. גם הודעה מאושרת לא תצא באמצע הלילה.
  if (!withinQuietWindow()) {
    await db.updateMessage(msg.id, { status: 'scheduled', send_at: nextMorning().toISOString() });
    return R.renderHeldForQuietHours(msg);
  }

  // מעקה 2 — תקרה יומית. בלם מוחלט מפני באג שמנסה להציף.
  const today = await db.sentTodayCount();
  if (today >= lim.dailyCap) {
    await db.updateMessage(msg.id, { status: 'scheduled', send_at: nextMorning().toISOString() });
    return `🛑 נשלחו כבר ${today} הודעות היום — זו התקרה. ההודעה נשמרה ותוצע שוב מחר.`;
  }

  // מעקה 3 — אותו נמען פעמיים בזמן קצר
  if (await db.sentRecentlyTo(msg.to_phone, lim.dedupeMinutes)) {
    return `⚠️ כבר נשלחה הודעה למספר הזה בדקות האחרונות. אם זה מכוון — שלח "שלח בכל זאת".`;
  }

  if (!deps.sendToContact) return 'הוואטסאפ לא מחובר כרגע — אנסה שוב מאוחר יותר.';

  try {
    await deps.sendToContact(user, msg.to_phone, msg.body);
    await db.updateMessage(msg.id, {
      status: 'sent', sent_at: new Date().toISOString(),
      approved_by: user.id, approved_at: new Date().toISOString(), last_error: null,
    });
    await db.logSent({
      message_id: msg.id, to_phone: msg.to_phone, to_name: msg.to_name,
      body: msg.body, approved_by: user.id,
    });
    console.log(`📤 הודעה נשלחה אל ${msg.to_name || msg.to_phone}`);
    return R.renderSent(msg);
  } catch (e) {
    await db.updateMessage(msg.id, { status: 'draft', last_error: String(e.message || e).slice(0, 300) });
    console.error('שליחה נכשלה:', e.message || e);
    return `❌ השליחה נכשלה (${e.message || 'שגיאה'}). ההודעה נשמרה כטיוטה ולא נשלחה.`;
  }
}

// ── מתזמן ───────────────────────────────────────────────────────────
/**
 * רץ כל דקה: מעביר הודעות שהגיע מועדן לאישור, ומפקיע כאלה
 * שנשאלו ולא נענו. הודעה שפגה חוזרת לטיוטה — לעולם לא נשלחת.
 */
export async function runOutbound(deps) {
  const lim = await limits();
  const now = Date.now();
  const users = new Map(deps.users().map((u) => [u.id, u]));

  for (const msg of await db.liveMessages()) {
    const user = users.get(msg.created_by);
    if (!user) continue;

    if (msg.status === 'scheduled' && msg.send_at && new Date(msg.send_at).getTime() <= now) {
      if (!withinQuietWindow()) continue;             // ממתין לבוקר
      try { await askApproval(user, msg, deps); } catch (e) { console.error('בקשת אישור:', e.message); }
      continue;
    }

    if (msg.status === 'awaiting_approval' && msg.asked_at) {
      const age = now - new Date(msg.asked_at).getTime();
      if (age > lim.expiryHours * 3600e3) {
        await db.updateMessage(msg.id, { status: 'draft', asked_at: null });
        try {
          await deps.sendTo(user, R.renderExpired(msg, lim.expiryHours));
        } catch { /* לא קריטי */ }
      }
    }
  }
}

function nextMorning() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);                             // חצות הקרוב
  return new Date(d.getTime() + 8 * 3600e3);           // ואז 08:00
}
