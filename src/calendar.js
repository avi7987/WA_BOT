// =====================================================================
//  calendar.js — יצירת זימונים ביומן גוגל.
//
//  שתי רמות, אותו קוד:
//    • יומן מחובר   → האירוע נוצר אוטומטית, ואורחים מקבלים הזמנה אמיתית
//    • לא מחובר     → הבוט מחזיר קישור מוכן ללחיצה אחת
//  זה מבטיח שהפיצ'ר שימושי מהרגע הראשון, ושכשל בחיבור לא משתק אותו.
//
//  אין כאן ספריית google — רק REST + refresh token, כדי לא לגרור
//  עשרות תלויות לקונטיינר שמריץ גם דפדפן.
// =====================================================================
import 'dotenv/config';
import * as db from './db.js';
import { TZ } from './util.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

export function isConnected() {
  return !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
}

// ── טוקן גישה (נשמר בזיכרון עד שפג) ─────────────────────────────────
let cachedToken = null;
let cachedUntil = 0;

async function accessToken() {
  if (cachedToken && Date.now() < cachedUntil - 60_000) return cachedToken;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant = הטוקן פג או בוטל. זה קורה כשהאפליקציה נשארה
    // במצב Testing (גוגל מפקיעים אחרי 7 ימים) — שווה לומר את זה במפורש.
    const hint = data.error === 'invalid_grant'
      ? ' — הטוקן פג. אם האפליקציה ב-Google Cloud עדיין במצב Testing, צריך להעביר אותה ל-In production ולחבר מחדש.'
      : '';
    throw new Error(`חידוש הטוקן נכשל (${data.error || res.status})${hint}`);
  }

  cachedToken = data.access_token;
  cachedUntil = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// ── יצירת אירוע ─────────────────────────────────────────────────────
/**
 * spec = { title, start (Date), end (Date|null), allDay, location, description, guests[] }
 * מחזיר { event, link } — או זורק. הקורא אחראי ליפול לקישור.
 */
export async function createEvent(spec) {
  const token = await accessToken();
  const body = {
    summary: spec.title,
    location: spec.location || undefined,
    description: spec.description || undefined,
    attendees: (spec.guests || []).map((email) => ({ email })),
  };

  if (spec.allDay) {
    // "טנטטיבי ביום ראשון" — אירוע יום שלם, מסומן כלא-ודאי
    body.start = { date: ymd(spec.start) };
    body.end = { date: ymd(addDaysUTC(spec.start, 1)) };
    body.status = 'tentative';
    body.transparency = 'transparent';        // לא חוסם את היום ביומן
  } else {
    const end = spec.end || new Date(spec.start.getTime() + 60 * 60e3);
    body.start = { dateTime: spec.start.toISOString(), timeZone: TZ };
    body.end = { dateTime: end.toISOString(), timeZone: TZ };
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?sendUpdates=all`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify(body),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`יצירת האירוע נכשלה (${res.status}): ${data?.error?.message || ''}`.slice(0, 200));
  return { googleId: data.id, link: data.htmlLink };
}

export async function deleteEvent(googleId) {
  const token = await accessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(googleId)}?sendUpdates=all`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`ביטול האירוע נכשל (${res.status})`);
  }
  return true;
}

// ── גיבוי: קישור מוכן ליומן ─────────────────────────────────────────
/**
 * קישור שפותח את יומן גוגל עם כל השדות ממולאים. לחיצה אחת ושמירה.
 * עובד בלי שום חיבור, הרשאה או מפתח.
 */
export function eventLink(spec) {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: spec.title, ctz: TZ });
  p.set('dates', spec.allDay
    ? `${ymdCompact(spec.start)}/${ymdCompact(addDaysUTC(spec.start, 1))}`
    : `${stamp(spec.start)}/${stamp(spec.end || new Date(spec.start.getTime() + 60 * 60e3))}`);
  if (spec.location) p.set('location', spec.location);
  if (spec.description) p.set('details', spec.description);
  for (const g of (spec.guests || [])) p.append('add', g);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

// ── כתובות אורחים ───────────────────────────────────────────────────
/**
 * "איה" → ayaokshus@gmail.com. הכינויים נשמרים בהגדרות כדי שאפשר
 * יהיה להוסיף עוד אנשים בלי לגעת בקוד.
 */
export async function resolveGuests(names = []) {
  const aliases = (await db.getSetting('calendar_guest_aliases', {})) || {};
  const out = [];
  const unknown = [];
  for (const raw of names) {
    const n = String(raw || '').trim();
    if (!n) continue;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n)) { out.push(n); continue; }
    const hit = Object.entries(aliases).find(([k]) => k === n || n.includes(k));
    if (hit) out.push(hit[1]); else unknown.push(n);
  }
  return { emails: [...new Set(out)], unknown };
}

// ── עזר ─────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const ymdCompact = (d) => ymd(d).replace(/-/g, '');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const addDaysUTC = (d, n) => new Date(d.getTime() + n * 864e5);
