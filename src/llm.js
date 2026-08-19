// =====================================================================
//  llm.js — הבנת עברית חופשית + תמלול הקלטות קוליות.
//
//  שני ספקים חינמיים נתמכים:
//    gemini — מפתח אחד עושה גם הבנה וגם תמלול (מומלץ)
//    groq   — הבנה מהירה + Whisper לתמלול
//  ואם אין מפתח בכלל — המערכת עדיין עובדת דרך parse.js, רק פחות חכמה.
// =====================================================================
import 'dotenv/config';
import { ilParts, HEB_DAYS, fmtDate, fmtTime } from './util.js';

const PROVIDER = (process.env.LLM_PROVIDER || 'none').toLowerCase();
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_STT = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

export function textAvailable() {
  return (PROVIDER === 'gemini' && !!GEMINI_KEY) || (PROVIDER === 'groq' && !!GROQ_KEY);
}
export function audioAvailable() {
  return textAvailable();     // שני הספקים תומכים גם באודיו
}
export function providerName() {
  return textAvailable() ? PROVIDER : 'none';
}

// ── הוראות המערכת ───────────────────────────────────────────────────
function systemPrompt(ctx) {
  const p = ilParts();
  const nowStr = `${HEB_DAYS[p.wd]}, ${p.d}.${p.m}.${p.y} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
  const who = (id) => (id === ctx.userId ? ctx.userName : id ? ctx.partnerName : null);
  const list = ctx.tasks.length
    ? ctx.tasks.map((t, i) => {
      const due = t.due_at ? (t.all_day ? fmtDate(new Date(t.due_at)) : `${fmtDate(new Date(t.due_at))} ${fmtTime(new Date(t.due_at))}`) : 'ללא תאריך';
      const zone = t.shared ? '[משותפת' + (t.assigned_to ? `, בטיפול ${who(t.assigned_to)}` : '') + ']' : '[אישית]';
      return `${i + 1}. ${t.title} — ${due} ${zone}`;
    }).join('\n')
    : '(אין משימות פתוחות)';

  return `You are a Hebrew-speaking personal task assistant running inside WhatsApp.
Your ONLY job is to convert the user's message into structured actions. You never chat at length.

CONTEXT
- Current date and time (Asia/Jerusalem): ${nowStr}
- The user's name: ${ctx.userName}
- Partner's name (for shared tasks): ${ctx.partnerName || '(none)'}
- The user's currently open tasks, numbered exactly as they were shown to them:
${list}

OUTPUT
Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "actions": [ ... ],
  "reply": "optional short Hebrew sentence, or null"
}

Allowed actions:
{"type":"add","title":"...","due":"ISO-8601 with +02:00/+03:00 offset or null","all_day":true|false,"shared":true|false,"assign":"me"|"partner"|null,"recurrence":"daily"|"weekly"|"monthly"|"yearly"|null,"notes":"...|null"}
{"type":"complete","ref": <number from the list above> | "<task title>"}
{"type":"snooze","ref": <number|title>, "due":"ISO-8601", "all_day":true|false}
{"type":"delete","ref": <number|title>}
{"type":"update","ref": <number|title>, "title":"...|null", "due":"ISO-8601|null", "all_day":true|false, "shared":true|false}
{"type":"assign","ref": <number|title>, "to":"me"|"partner"|null}
{"type":"note","ref": <number|title>, "text":"the note itself, in Hebrew"}
{"type":"show_notes","ref": <number|title>}
{"type":"list","filter":"digest"|"today"|"tomorrow"|"week"|"overdue"|"all"|"shared"|"done"|"mine_assigned"|"partner_assigned"}
{"type":"none"}

RULES
1. One message may contain SEVERAL tasks — emit one "add" per task. Split on "ו..." / commas / new lines when they are clearly separate errands.
2. Resolve every relative date against the current date above. "מחר" = tomorrow, "יום ראשון" = the NEXT Sunday, "בעוד שבועיים" = +14 days.
3. If no time of day was stated, set "all_day": true and use 09:00 as the hour.
4. "title" must be a short clean action phrase in Hebrew, WITHOUT the date words and WITHOUT filler like "תזכיר לי". Keep the user's own wording otherwise. Never invent details.
5. ZONES — this is the most important rule. There are exactly three zones:
   - "${ctx.userName}"'s private zone, "${ctx.partnerName || 'the partner'}"'s private zone, and one SHARED zone.
   - Neither person can ever write into the other's private zone. A task concerning the other person ALWAYS goes to the shared zone.
   - Default is PRIVATE ("shared": false). Set "shared": true whenever the message implies the other person or both of them — you must infer this from meaning, NOT from the literal word "משותף". Examples that are shared:
     • "צריך שמישהו יקנה חלב"            → shared, assign: null
     • "אנחנו צריכים להזמין מסעדה"        → shared, assign: null
     • "ש${ctx.partnerName || 'בן הזוג'} יאסוף את הילד ב-4"  → shared, assign: "partner"
     • "תטיל על ${ctx.partnerName || 'בן הזוג'} לקחת את הדואר" → shared, assign: "partner"
     • "${ctx.partnerName || 'בן הזוג'} — להזמין תור לרופא"   → shared, assign: "partner"
     • "משותף / ביחד / שנינו"             → shared, assign: null
   - Examples that stay private: "לקנות מתנה לאמא שלי", "לשלם ארנונה", "פגישה עם רו״ח".
6. ASSIGNMENT — "assign" says who handles a shared task: "me" = ${ctx.userName}, "partner" = ${ctx.partnerName || 'the partner'}, null = both/unspecified.
   - Setting "assign" ALWAYS forces "shared": true. Assignment exists only inside the shared zone.
   - "אני אקח את זה" / "אני אטפל" on an existing task → {"type":"assign","ref":N,"to":"me"}.
   - "תעביר את זה ל${ctx.partnerName || 'בן הזוג'}" → {"type":"assign","ref":N,"to":"partner"}.
7. NOTES — extra information ABOUT an existing task, not a new task.
   - "כבר קניתי חלב, צריך רק לחם" while a milk task exists → {"type":"note","ref":N,"text":"כבר קניתי חלב, צריך רק לחם"}
   - "תוסיף הערה ל-3 ש..." / "רשום על הפגישה ש..." → note
   - "מה ההערות על 3" / "מה כתוב על הפגישה" → show_notes
   - Careful: if it describes something NEW to do, it is an "add", not a note.
8. If the user reports finishing something ("סיימתי עם הארנונה", "שילמתי"), emit "complete" and match it to the closest task by meaning — use its number.
9. If the user just asks what they have ("מה יש לי היום"), emit a "list" action only.
10. If nothing actionable was said, emit {"type":"none"} and put a one-line Hebrew answer in "reply".
11. "reply" should stay empty (null) whenever an action already speaks for itself — the app writes its own confirmations.
12. Never output explanations, markdown, or text outside the JSON object.`;
}

// ── פענוח הודעה ─────────────────────────────────────────────────────
export async function interpret(text, ctx) {
  if (!textAvailable()) return null;
  try {
    const raw = PROVIDER === 'gemini'
      ? await geminiText(systemPrompt(ctx), text)
      : await groqText(systemPrompt(ctx), text);
    const json = extractJson(raw);
    if (!json || !Array.isArray(json.actions)) return null;
    return json;
  } catch (e) {
    console.error('⚠️  LLM interpret נכשל:', e.message || e);
    return null;
  }
}

// ── תמלול הקלטה קולית ───────────────────────────────────────────────
export async function transcribe(base64, mimetype) {
  if (!audioAvailable()) return null;
  try {
    return PROVIDER === 'gemini'
      ? await geminiAudio(base64, mimetype)
      : await groqAudio(base64, mimetype);
  } catch (e) {
    console.error('⚠️  תמלול נכשל:', e.message || e);
    return null;
  }
}

// ── Gemini ──────────────────────────────────────────────────────────
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// עומס אצל הספק (503) או חריגה מקצב (429) הם זמניים — שווה לנסות שוב
// לפני שנופלים לפרסר המקומי.
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function geminiText(system, user) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(attempt * 1500);
    const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      signal: AbortSignal.timeout(35000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', maxOutputTokens: 2048 },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    }
    last = new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!TRANSIENT.has(res.status)) break;
    console.warn(`⚠️  Gemini ${res.status} — מנסה שוב (${attempt + 1}/3)`);
  }
  throw last;
}

async function geminiAudio(base64, mimetype) {
  const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: cleanMime(mimetype), data: base64 } },
          { text: 'תמלל את ההקלטה הזו לעברית, מילה במילה. החזר אך ורק את הטקסט המתומלל, בלי הקדמה ובלי הערות.' },
        ],
      }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini audio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '').trim() || null;
}

// ── Groq ────────────────────────────────────────────────────────────
async function groqText(system, user) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
    signal: AbortSignal.timeout(35000),
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function groqAudio(base64, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: cleanMime(mimetype) }), 'audio.ogg');
  form.append('model', GROQ_STT);
  form.append('language', 'he');
  form.append('response_format', 'text');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Groq STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.text()).trim() || null;
}

// ── עזר ─────────────────────────────────────────────────────────────
function cleanMime(m) {
  const base = String(m || 'audio/ogg').split(';')[0].trim();
  // וואטסאפ שולח opus בתוך ogg; Gemini מכיר audio/ogg
  return base === 'audio/ogg' || base.startsWith('audio/') ? base : 'audio/ogg';
}

// מודלים לפעמים עוטפים ב-```json — מחלצים את האובייקט הראשון
function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* ממשיכים */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ויתרנו */ }
  }
  return null;
}
