// =====================================================================
//  index.js — נקודת הכניסה של "המנהל האישי".
//
//  מרים סשן וואטסאפ לכל אדם (אתה + בן/בת הזוג), מקשיב לצ'אט
//  "הודעה לעצמי" של כל אחד, ומריץ את המתזמן של סיכום הבוקר.
// =====================================================================
import 'dotenv/config';
import http from 'http';
import * as db from './db.js';
import * as llm from './llm.js';
import { createSession, downloadVoice, isVoiceMessage } from './wa.js';
import { handleMessage } from './brain.js';
import { startScheduler } from './scheduler.js';
import { renderHelp } from './render.js';

const STARTED_AT = Date.now();
const PORT = process.env.PORT || 3000;

// ── מי משתתף ────────────────────────────────────────────────────────
const PEOPLE = [
  { key: 'owner', name: process.env.OWNER_NAME || 'אני', role: 'owner', sees_own_tasks: true, default_shared: false },
];
if (String(process.env.ENABLE_PARTNER) === 'true') {
  PEOPLE.push({
    key: 'partner',
    name: process.env.PARTNER_NAME || 'בן/בת הזוג',
    role: 'member',
    // הרשימה של בן/בת הזוג היא הרשימה המשותפת בלבד,
    // וכל משימה שהם מוסיפים נכנסת אליה אוטומטית.
    sees_own_tasks: false,
    default_shared: true,
  });
}

const sessions = new Map();   // key → session
const users = new Map();      // key → שורת pa_users

const partnerOf = (user) => {
  for (const u of users.values()) if (u.id !== user.id) return u;
  return null;
};

const sessionFor = (user) => sessions.get(user.session_key);

async function sendTo(user, text) {
  const s = sessionFor(user);
  if (!s) return;
  await s.send(text);
}

const deps = {
  partnerOf,
  notify: sendTo,
  sendTo,
  users: () => [...users.values()],
};

// ── טיפול בהודעה שהגיעה בצ'אט "הודעה לעצמי" ─────────────────────────
async function onSelfMessage(session, msg) {
  // מתעלמים מהיסטוריה שמסתנכרנת בעליית השרת
  if (msg.timestamp && msg.timestamp * 1000 < STARTED_AT - 60_000) return;

  const user = users.get(session.key);
  if (!user) return;

  let text = (msg.body || '').trim();
  let heard = null;

  // ── הקלטה קולית → תמלול ──
  // כלל ברזל: אף שלב כאן לא נכשל בשקט. כל תקלה חוזרת אליך כהודעה.
  if (isVoiceMessage(msg)) {
    if (!llm.audioAvailable()) {
      await session.send('🎤 קיבלתי הקלטה, אבל תמלול דורש מפתח AI (GEMINI_API_KEY בהגדרות). בינתיים אפשר לכתוב לי בטקסט.');
      return;
    }
    let voice = null;
    try {
      voice = await downloadVoice(session, msg);
    } catch (e) {
      console.error('הורדת הקלטה נכשלה:', e.message || e);
      await session.send(`🎤 קיבלתי את ההקלטה אבל לא הצלחתי להוריד אותה מוואטסאפ (${e.message || 'שגיאה'}). נסה לשלוח שוב, או לכתוב בטקסט.`);
      return;
    }
    const t = await llm.transcribe(voice.base64, voice.mimetype);
    if (!t) {
      await session.send('🎤 ההקלטה הגיעה אבל התמלול לא הצליח. אפשר לנסות שוב או לכתוב בטקסט.');
      return;
    }
    text = t;
    heard = t;
    console.log(`🎧 ${user.name}: תומללו ${t.length} תווים`);
  }

  if (!text) {
    await session.send('קיבלתי הודעה שאני לא יודע לקרוא (סוג: ' + msg.type + '). אפשר לכתוב או להקליט לי.');
    return;
  }

  try {
    const reply = await handleMessage(user, text, deps, { heard });
    if (reply) await session.send(reply);
  } catch (e) {
    console.error('שגיאה במוח:', e);
    await session.send('משהו השתבש אצלי. נסה שוב, או שלח "עזרה".');
  }
}

// ── הרמת הסשנים ─────────────────────────────────────────────────────
async function boot() {
  console.log('⏳ מאתחל את המנהל האישי...');
  console.log(`   node ${process.version} · AI: ${llm.providerName()} · PORT=${PORT}`);

  // שלב א' — רושמים את כל המשתתפים לפני שמרימים סשנים,
  // כדי שכל אחד כבר "מכיר" את השני (שם בן/בת הזוג בהודעות).
  for (const person of PEOPLE) {
    const row = await db.upsertUser(person.key, {
      name: person.name,
      role: person.role,
      sees_own_tasks: person.sees_own_tasks,
      default_shared: person.default_shared,
      digest_time: process.env.DIGEST_TIME || '08:00',
      evening_digest: String(process.env.EVENING_DIGEST) === 'true',
      active: true,
    });
    users.set(person.key, row);
  }

  // שלב ב' — חיבור לוואטסאפ, אחד אחרי השני
  for (const person of PEOPLE) {
    const session = createSession({
      key: person.key,
      label: person.name,
      onSelfMessage,
    });
    sessions.set(person.key, session);

    session.client.on('ready', async () => {
      try {
        const updated = await db.upsertUser(person.key, { phone: session.phone, name: person.name });
        users.set(person.key, updated);
      } catch (e) { console.error('שמירת מספר:', e.message); }
      await greetOnce(person.key, session);
    });

    session.client.initialize().catch((e) => {
      console.error(`❌ ${person.name}: האתחול נכשל —`, e.message || e);
    });

    // מחכים שהסשן הזה יתחבר לפני שמרימים את הבא — אחרת שני קודי QR
    // מופיעים יחד בטרמינל ואי אפשר לדעת איזה שייך למי.
    // אם החיבור לא מסתדר, ממשיכים בכל מקרה כדי שהשאר יעבוד.
    await waitForReady(session, 5 * 60_000);
  }

  startScheduler(deps);
}

function waitForReady(session, timeoutMs) {
  if (session.state === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); session.client.off('ready', onReady); resolve(ok); };
    const onReady = () => done(true);
    const timer = setTimeout(() => {
      console.warn(`⏱️  ${session.label}: עוד לא מחובר — ממשיך בלעדיו בינתיים.`);
      done(false);
    }, timeoutMs);
    session.client.once('ready', onReady);
  });
}

// הודעת פתיחה — פעם אחת בלבד, בפעם הראשונה שהחיבור עולה
async function greetOnce(key, session) {
  const flag = `greeted_${key}`;
  if (await db.getSetting(flag)) return;
  await db.setSetting(flag, true);
  const user = users.get(key);
  const partner = user ? partnerOf(user) : null;
  await session.send(
    '👋 *היי, אני המנהל האישי שלך.*\n' +
    'מעכשיו אפשר לכתוב לי כאן בצ׳אט הזה — או להקליט — כל משימה שעולה לך בראש, ואני אזכור בשבילך.\n\n' +
    'כל בוקר תקבל כאן רשימה מסודרת: מה באיחור, מה להיום, ומה מחכה בהמשך.\n\n' +
    renderHelp({ partnerName: partner?.name })
  );
}

// ── עמוד בריאות (בשביל הענן) — בלי שום מידע רגיש ────────────────────
http.createServer((req, res) => {
  const state = {};
  for (const [k, s] of sessions) state[k] = s.state;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, up: Math.round((Date.now() - STARTED_AT) / 1000), sessions: state }));
}).listen(PORT, () => console.log(`🌐 עמוד בריאות על פורט ${PORT}`));

// אם הצד שקורא את הפלט נסגר (טרמינל שנסגר, סשן שהתנתק), כתיבה ללוג
// זורקת EPIPE ומשתקת את התהליך. הבוט לא אמור למות בגלל שאף אחד לא מסתכל.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e?.code !== 'EPIPE') { /* מתעלמים בשקט */ } });
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.stack) || e));
process.on('exit', (code) => console.error(`⛔ התהליך מסתיים (קוד ${code})`));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { console.error(`⛔ התקבל ${sig}`); process.exit(0); });
}

boot().catch((e) => {
  console.error('❌ עלייה נכשלה:', e);
  process.exit(1);
});
