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
  const list = ctx.tasks.length
    ? ctx.tasks.map((t, i) => {
      const due = t.due_at ? (t.all_day ? fmtDate(new Date(t.due_at)) : `${fmtDate(new Date(t.due_at))} ${fmtTime(new Date(t.due_at))}`) : 'ללא תאריך';
      return `${i + 1}. ${t.title} — ${due}${t.shared ? ' [משותפת]' : ''}`;
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
{"type":"add","title":"...","due":"ISO-8601 with +02:00/+03:00 offset or null","all_day":true|false,"shared":true|false,"recurrence":"daily"|"weekly"|"monthly"|"yearly"|null,"notes":"...|null"}
{"type":"complete","ref": <number from the list above> | "<task title>"}
{"type":"snooze","ref": <number|title>, "due":"ISO-8601", "all_day":true|false}
{"type":"delete","ref": <number|title>}
{"type":"update","ref": <number|title>, "title":"...|null", "due":"ISO-8601|null", "all_day":true|false, "shared":true|false}
{"type":"list","filter":"digest"|"today"|"tomorrow"|"week"|"overdue"|"all"|"shared"|"done"}
{"type":"none"}

RULES
1. One message may contain SEVERAL tasks — emit one "add" per task. Split on "ו..." / commas / new lines when they are clearly separate errands.
2. Resolve every relative date against the current date above. "מחר" = tomorrow, "יום ראשון" = the NEXT Sunday, "בעוד שבועיים" = +14 days.
3. If no time of day was stated, set "all_day": true and use 09:00 as the hour.
4. "title" must be a short clean action phrase in Hebrew, WITHOUT the date words and WITHOUT filler like "תזכיר לי". Keep the user's own wording otherwise. Never invent details.
5. Mark "shared": true only when the user clearly means both of them (משותף / ביחד / שנינו / עם ${ctx.partnerName || 'בן הזוג'}). Otherwise false.${ctx.defaultShared ? '\n   NOTE: for THIS user the default is shared:true unless they say it is private (פרטי / רק שלי).' : ''}
6. If the user reports finishing something ("סיימתי עם הארנונה", "שילמתי"), emit "complete" and match it to the closest task by meaning — use its number.
7. If the user just asks what they have ("מה יש לי היום"), emit a "list" action only.
8. If nothing actionable was said, emit {"type":"none"} and put a one-line Hebrew answer in "reply".
9. "reply" should stay empty (null) whenever an action already speaks for itself — the app writes its own confirmations.
10. Never output explanations, markdown, or text outside the JSON object.`;
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

async function geminiText(system, user) {
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
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
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
