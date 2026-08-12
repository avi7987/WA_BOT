// =====================================================================
//  wa.js — חיבור לוואטסאפ כמכשיר מקושר, אחד לכל אדם.
//
//  הבוט מקשיב אך ורק לצ'אט "הודעה לעצמי" של אותו אדם.
//  שום צ'אט אחר לא נקרא, לא נשמר ולא נוגעים בו.
// =====================================================================
import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

const SESSION_ROOT = process.env.WA_SESSION_PATH || './.wwebjs_auth';

export function createSession({ key, label, onSelfMessage }) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: key, dataPath: SESSION_ROOT }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });

  const session = {
    key, label, client,
    state: 'starting',
    selfId: null,
    phone: null,
    send: (text) => sendSelf(session, text),
  };

  // ── מניעת לולאה: הבוט לא מגיב להודעות של עצמו ──
  const sentIds = new Set();
  const sentBodies = new Map();          // hash → זמן
  session._sentIds = sentIds;
  session._sentBodies = sentBodies;

  client.on('qr', async (qr) => {
    session.state = 'qr';
    console.log(`\n📲 סרוק את הקוד הבא מהטלפון של *${label}*`);
    console.log('   וואטסאפ → הגדרות → מכשירים מקושרים → קישור מכשיר\n');
    qrTerminal.generate(qr, { small: true });
    try {
      const file = path.resolve(`./qr-${key}.png`);
      await QRCode.toFile(file, qr, { width: 420, margin: 2 });
      console.log(`   (הקוד נשמר גם כתמונה: ${file})\n`);
    } catch { /* לא קריטי */ }
  });

  client.on('authenticated', () => console.log(`🔐 ${label}: אומת בהצלחה`));

  client.on('ready', async () => {
    session.state = 'ready';
    const wid = client.info?.wid;
    session.selfId = wid?._serialized || null;
    session.phone = wid?.user || null;
    session.selfLid = await discoverSelfLid(client);
    try {
      const f = path.resolve(`./qr-${key}.png`);
      if (fs.existsSync(f)) fs.unlinkSync(f);       // לא משאירים קוד קישור מסתובב
    } catch { /* לא קריטי */ }
    console.log(`✅ ${label}: מחובר (${session.phone}). מקשיב לצ'אט "הודעה לעצמי" בלבד.`);
  });

  client.on('auth_failure', (m) => {
    session.state = 'disconnected';
    console.error(`❌ ${label}: כשל אימות —`, m);
  });

  client.on('disconnected', (reason) => {
    session.state = 'disconnected';
    console.error(`⚠️  ${label}: נותק (${reason}). מנסה להתחבר מחדש בעוד 5 שניות...`);
    setTimeout(() => client.initialize().catch((e) => console.error(e.message)), 5000);
  });

  client.on('message_create', async (msg) => {
    try {
      if (!session.selfId) return;
      if (!msg.fromMe) return;

      // אבחון (DEBUG_WA=true): מדפיס רק מזהי שיחה וסוג — בלי תוכן ההודעה
      if (process.env.DEBUG_WA === 'true') {
        console.log(`🔎 [${label}] fromMe · type=${msg.type} · chat=${chatIdOf(msg)} · from=${msg.from} · to=${msg.to} · self=${session.selfId}`);
      }
      // רק הצ'אט עם עצמי — לא נוגעים בשום שיחה אחרת.
      if (!(await isSelfChat(session, msg))) return;
      // הודעות מערכת (אישורי מסירה, שינויי הצפנה, תגובות) — לא רלוונטיות
      if (!['chat', 'ptt', 'audio'].includes(msg.type)) return;

      const id = serialId(msg);
      if (id && sentIds.has(id)) return;                       // הודעה שהבוט עצמו שלח
      const body = (msg.body || '').trim();
      if (body && isRecentlySent(sentBodies, body)) return;    // גיבוי לזיהוי הד

      await onSelfMessage(session, msg);
    } catch (e) {
      console.error(`שגיאה בטיפול בהודעה (${label}):`, e.message || e);
    }
  });

  return session;
}

// המזהה הייחודי של ההודעה.
// וואטסאפ הסירו את id._serialized והערך עבר לשדה ממוזער ($1 כרגע) —
// לכן מחפשים אותו גם שם, ואם אין, מרכיבים אותו מהחלקים.
function serialId(msg) {
  const i = msg?.id;
  if (!i) return null;
  if (typeof i._serialized === 'string') return i._serialized;
  for (const k of Object.keys(i)) {
    const v = i[k];
    if (typeof v === 'string' && v.includes('_') && v.includes(String(i.id || '\0'))) return v;
  }
  return i.id ? `${i.fromMe}_${String(i.remote)}_${i.id}` : null;
}

// מזהה השיחה שאליה שייכת ההודעה (עמיד לשינויי מבנה בין גרסאות)
function chatIdOf(msg) {
  const r = msg.id?.remote;
  if (typeof r === 'string') return r;
  if (r?._serialized) return r._serialized;
  return msg.to || msg.from;
}

// ── זיהוי "הצ'אט עם עצמי" ────────────────────────────────────────────
//  וואטסאפ עברו לכתובות @lid (מזהה פרטיות) במקום מספר הטלפון, ולכן
//  אי אפשר פשוט להשוות מזהים — צריך לתרגם LID חזרה למספר ולהשוות אליו.
const lidPhoneCache = new Map();

async function isSelfChat(session, msg) {
  const chat = chatIdOf(msg);
  if (!chat) return false;
  if (chat === session.selfId) return true;             // המצב הישן, עדיין קיים
  if (chat === session.selfLid) return true;            // כבר זיהינו את ה-LID שלנו
  if (chat.endsWith('@g.us')) return false;             // קבוצה — לא רלוונטי
  if (!chat.endsWith('@lid')) return false;

  const phone = await lidToPhone(session.client, chat);
  if (phone && phone === session.phone) {
    session.selfLid = chat;                             // שומרים, כדי לא לתרגם שוב
    console.log(`ℹ️  ${session.label}: הצ'אט עם עצמי מזוהה כ-${chat}`);
    return true;
  }
  return false;
}

// ה-LID שלנו עצמנו, כדי שגם ההודעות שאנחנו שולחים יגיעו לצ'אט הנכון
async function discoverSelfLid(client) {
  try {
    return await client.pupPage.evaluate(() => {
      try {
        const m = window.require('WAWebUserPrefsMeUser');
        const fn = m.getMaybeMeLidUser || m.getMeLidUser;
        const v = fn ? fn.call(m) : null;
        return v ? (v._serialized || String(v)) : null;
      } catch { return null; }
    });
  } catch { return null; }
}

// תרגום LID → מספר טלפון, דרך המודול הפנימי שוואטסאפ-ווב עצמו משתמש בו
async function lidToPhone(client, lid) {
  if (lidPhoneCache.has(lid)) return lidPhoneCache.get(lid);
  let digits = null;
  try {
    const num = await client.pupPage.evaluate((l) => {
      const wid = window.require('WAWebWidFactory').createWid(l);
      const phone = window.require('WAWebApiContact').getPhoneNumber(wid);
      return phone ? (phone._serialized || String(phone)) : null;
    }, lid);
    digits = num ? String(num).replace(/\D/g, '') : null;
  } catch (e) {
    if (process.env.DEBUG_WA === 'true') console.log(`🔎 תרגום LID נכשל (${lid}): ${e.message}`);
  }
  lidPhoneCache.set(lid, digits);
  return digits;
}

// ── שליחה לצ'אט "הודעה לעצמי" ───────────────────────────────────────
export async function sendSelf(session, text) {
  if (!text) return null;
  const target = session.selfLid || session.selfId;    // וואטסאפ החדש מכתובת לפי LID
  if (session.state !== 'ready' || !target) {
    console.warn(`⚠️  ${session.label}: לא מחובר — ההודעה לא נשלחה.`);
    return null;
  }
  remember(session._sentBodies, text);
  const msg = await session.client.sendMessage(target, text);
  const id = serialId(msg);
  if (id) {
    session._sentIds.add(id);
    if (session._sentIds.size > 500) session._sentIds.clear();
  }
  return msg;
}

// ── הד: זיכרון קצר של מה שהבוט שלח ──────────────────────────────────
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return String(h);
}

function remember(map, text) {
  map.set(hash(text.trim()), Date.now());
  if (map.size > 200) {
    const cutoff = Date.now() - 5 * 60e3;
    for (const [k, v] of map) if (v < cutoff) map.delete(k);
  }
}

function isRecentlySent(map, text) {
  const t = map.get(hash(text));
  if (!t) return false;
  return Date.now() - t < 5 * 60e3;
}

// ── הקלטה קולית ─────────────────────────────────────────────────────
export const isVoiceMessage = (msg) => msg.type === 'ptt' || msg.type === 'audio';

/**
 * מוריד את קובץ ההקלטה.
 *
 * לא משתמשים ב-msg.downloadMedia() של הספרייה: היא מחפשת את ההודעה לפי
 * id._serialized, ובגרסה הנוכחית של וואטסאפ השדה הזה כבר לא קיים (הערך עבר
 * לשדה ממוזער בשם $1). התוצאה היא חיפוש עם מזהה ריק ו-DataError מוקטן ל-"r".
 * לכן מאתרים את ההודעה לפי שדות המזהה עצמם, ומורידים ישירות.
 *
 * זורק שגיאה מפורשת אם נכשל — הקורא חייב לדווח למשתמש ולא לשתוק.
 */
export async function downloadVoice(session, msg) {
  if (!isVoiceMessage(msg)) return null;

  const want = {
    id: msg.id?.id || null,
    remote: String(msg.id?.remote || ''),
    fromMe: !!msg.id?.fromMe,
  };
  if (!want.id) throw new Error('להודעה אין מזהה פנימי');

  const result = await session.client.pupPage.evaluate(async (w) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const Col = window.require('WAWebCollections');

    const find = () => Col.Msg.getModelsArray()
      .find((m) => m.id && m.id.id === w.id && !!m.id.fromMe === w.fromMe);

    let m = find();
    for (let i = 0; !m && i < 5; i++) { await sleep(600); m = find(); }
    if (!m) return { error: 'ההודעה לא נמצאה בזיכרון של וואטסאפ' };

    // וואטסאפ מעלה את המדיה ברקע — מחכים שהיא תהיה מוכנה
    for (let i = 0; i < 8; i++) {
      const stage = m.mediaData?.mediaStage;
      if (stage === 'RESOLVED') break;
      if (stage && (stage.includes('ERROR') || stage === 'REUPLOADING')) {
        return { error: 'מצב המדיה: ' + stage };
      }
      try {
        await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      } catch { /* מנסים שוב בסבב הבא */ }
      if (m.mediaData?.mediaStage === 'RESOLVED') break;
      await sleep(700);
    }

    if (!m.directPath || !m.mediaKey) {
      return { error: 'חסרים פרטי הורדה (מצב: ' + (m.mediaData?.mediaStage || 'לא ידוע') + ')' };
    }

    try {
      const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
      const decrypted = await window.require('WAWebDownloadManager').downloadManager
        .downloadAndMaybeDecrypt({
          directPath: m.directPath,
          encFilehash: m.encFilehash,
          filehash: m.filehash,
          mediaKey: m.mediaKey,
          mediaKeyTimestamp: m.mediaKeyTimestamp,
          type: m.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });
      const data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
      return { data, mimetype: m.mimetype || 'audio/ogg' };
    } catch (e) {
      return { error: 'ההורדה נכשלה: ' + (e?.message || e?.name || String(e)).slice(0, 120) };
    }
  }, want);

  if (!result || result.error) throw new Error(result?.error || 'הורדת ההקלטה נכשלה');

  const bytes = Math.floor((result.data.length * 3) / 4);
  if (bytes > 12 * 1024 * 1024) throw new Error('ההקלטה ארוכה מדי (מעל 12MB)');
  return { base64: result.data, mimetype: result.mimetype };
}
