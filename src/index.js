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
import { createSession, downloadVoice, isVoiceMessage, sendToContact, findContacts } from './wa.js';
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
    // מודל שלושת האזורים: לכל אחד אזור אישי משלו, ואזור משותף אחד.
    // סימטרי לחלוטין — משימה היא אישית אלא אם ההקשר מרמז על שניהם.
    sees_own_tasks: true,
    default_shared: false,
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
  // המתזמן שואל לפני שהוא "מוציא" סיכום יומי — אחרת יום שלם
  // מסומן כנשלח בזמן שהוואטסאפ מנותק, והסיכום אובד.
  isReady: (user) => sessionFor(user)?.state === 'ready',
  sessionOf: sessionFor,
  // שליחה לאנשים אחרים וחיפוש אנשי קשר — מוזרקים, כדי שהלוגיקה
  // תהיה ניתנת לבדיקה בלי וואטסאפ אמיתי
  sendToContact: async (user, phone, text) => {
    const s = sessionFor(user);
    if (!s) throw new Error('הוואטסאפ לא מחובר');
    return sendToContact(s, phone, text);
  },
  findContacts: async (user, q) => {
    const s = sessionFor(user);
    return s ? findContacts(s, q) : [];
  },
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
      session._wasLinked = true;
    });

    // סשן שהיה מחובר וירד לדרישת QR = ניתוק אמיתי, לא הקמה ראשונית.
    // אי אפשר להודיע לו בוואטסאפ (זה בדיוק מה שנפל), אז לפחות
    // מודיעים לצד השני אם הוא עוד מחובר, וצועקים בלוג.
    session.client.on('qr', async () => {
      if (!session._wasLinked || session._alerted) return;
      session._alerted = true;
      console.error(`🚨 ${person.name}: החיבור לוואטסאפ נותק ודורש סריקה מחדש! הבוט לא יגיב עד שיסרקו.`);
      const me = users.get(person.key);
      const other = me ? partnerOf(me) : null;
      if (other && sessionFor(other)?.state === 'ready') {
        await sendTo(other, `🚨 החיבור של ${person.name} לבוט נותק וצריך לסרוק QR מחדש. עד אז הוא לא יקבל ולא ישלח כלום.`);
      }
    });

    // הפעלת הדפדפן נכשלת לפעמים באופן רגעי (עומס, קונטיינר שעוד נסגר).
    // בלי ניסיון חוזר הבוט היה נשאר "חי" אבל בלי דפדפן — כלומר מת בשקט.
    initWithRetry(session, person.name);

    // מחכים שהסשן הזה יתחבר לפני שמרימים את הבא — אחרת שני קודי QR
    // מופיעים יחד בטרמינל ואי אפשר לדעת איזה שייך למי.
    // אם החיבור לא מסתדר, ממשיכים בכל מקרה כדי שהשאר יעבוד.
    await waitForReady(session, 5 * 60_000);
  }

  startScheduler(deps);
  startWatchdog();
}

async function initWithRetry(session, label, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await session.client.initialize();
      return true;
    } catch (e) {
      console.error(`❌ ${label}: אתחול נכשל (${i}/${attempts}) — ${e.message || e}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 8000));
    }
  }
  console.error(`❌ ${label}: לא הצלחתי להפעיל דפדפן. השומר יאתחל את השירות.`);
  return false;
}

// ── שומר ראש ────────────────────────────────────────────────────────
// אם סשן תקוע ולא מגיע ל-ready, עדיף להפיל את התהליך ולתת לדוקר
// להרים אותו נקי (restart: unless-stopped) מאשר להישאר חי-אך-מושבת.
function startWatchdog(graceMs = 12 * 60_000) {
  const since = new Map();
  const revived = new Set();

  setInterval(async () => {
    for (const [key, s] of sessions) {
      // 'qr' = ממתין שאדם יסרוק. זו לא תקיעה, וזה יכול להימשך שעות —
      // אסור שהשומר יפיל את השירות באמצע ויבטל את הקוד שהוצג.
      if (s.state === 'ready' || s.state === 'qr') { since.delete(key); revived.delete(key); continue; }
      if (!since.has(key)) since.set(key, Date.now());
      const stuckFor = Date.now() - since.get(key);
      if (stuckFor <= graceMs) continue;

      // ניסיון ראשון: להחיות את הסשן לבד, בלי להרוג את התהליך.
      // הריגה קוטעת את כרומיום באמצע כתיבה ופוגמת את קובצי החיבור —
      // וזה מה שגורם לדרישת QR מחדש. עדיף לנסות בעדינות קודם.
      if (!revived.has(key)) {
        revived.add(key);
        since.set(key, Date.now());
        console.error(`⚠️  ${s.label}: תקוע ${Math.round(stuckFor / 60000)} דקות — מנסה להחיות את הסשן.`);
        try {
          await Promise.race([s.client.destroy(), new Promise((r) => setTimeout(r, 15_000))]);
          await s.client.initialize();
          console.error(`   ✓ ${s.label}: אותחל מחדש`);
        } catch (e) {
          console.error(`   ✗ ${s.label}: ההחייאה נכשלה — ${e.message}`);
        }
        continue;
      }

      // ההחייאה לא עזרה — מפילים, אבל בסגירה מסודרת
      console.error(`⛔ ${s.label}: עדיין תקוע אחרי החייאה — מאתחל את השירות.`);
      await shutdown(`${s.label} תקוע`, 1);
      return;
    }
  }, 60_000);
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

/**
 * סגירה מסודרת של הדפדפנים לפני יציאה.
 *
 * זה לא ליטוש: הריגה של כרומיום באמצע כתיבה משאירה את קובצי
 * החיבור לוואטסאפ חצי-כתובים, ואז נדרשת סריקת QR מחדש. בדיוק כך
 * אבד החיבור ב-3.9. סגירה מסודרת מאפשרת לכרומיום לסיים לכתוב.
 */
let shuttingDown = false;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`⛔ סוגר (${reason}) — סוגר דפדפנים בצורה מסודרת...`);
  await Promise.all([...sessions.values()].map(async (s) => {
    try {
      await Promise.race([
        s.client.destroy(),
        new Promise((r) => setTimeout(r, 15_000)),   // לא נתקעים לנצח על סגירה
      ]);
      console.error(`   ✓ ${s.label} נסגר`);
    } catch (e) { console.error(`   ✗ ${s.label}: ${e.message}`); }
  }));
  process.exit(code);
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.stack) || e));
process.on('exit', (code) => console.error(`⛔ התהליך מסתיים (קוד ${code})`));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => shutdown(sig, 0));
}

boot().catch((e) => {
  console.error('❌ עלייה נכשלה:', e);
  process.exit(1);
});
