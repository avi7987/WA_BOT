// בדיקת חיבורים לפני שמתחברים לוואטסאפ:  npm run check
// בודק שבסיס הנתונים עונה, שכל הטבלאות קיימות, ושמפתח ה-AI עובד.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const ok = (s) => console.log(`  ✅ ${s}`);
const bad = (s) => { console.log(`  ❌ ${s}`); failed = true; };
let failed = false;

console.log('\n🔍 בדיקת הגדרות\n');

// ── 1. משתני סביבה ──
console.log('משתני סביבה:');
const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY'];
for (const k of need) {
  const v = process.env[k];
  if (!v) bad(`${k} — חסר`);
  else if (/^["'].*["']$/.test(v)) bad(`${k} — יש מרכאות סביב הערך, צריך להסיר`);
  else ok(`${k} — קיים (${v.length} תווים)`);
}
if (failed) { console.log('\nתקן את מה שמסומן ונסה שוב.\n'); process.exit(1); }

// ── 2. בסיס הנתונים ──
console.log('\nבסיס הנתונים:');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TABLES = ['pa_users', 'pa_tasks', 'pa_refs', 'pa_state', 'pa_log', 'pa_settings'];
for (const t of TABLES) {
  const { error } = await sb.from(t).select('*', { count: 'exact', head: true });
  if (error) bad(`${t} — ${error.message}`);
  else ok(`${t}`);
}

// כתיבה+מחיקה אמיתית, כדי לוודא שהמפתח באמת עוקף RLS
if (!failed) {
  const probe = 'setup_check_' + Date.now();
  const { error: wErr } = await sb.from('pa_settings').upsert({ key: probe, value: true });
  if (wErr) bad(`כתיבה נכשלה — ${wErr.message} (כנראה זה מפתח ה-anon ולא service_role)`);
  else {
    await sb.from('pa_settings').delete().eq('key', probe);
    ok('כתיבה ומחיקה עובדות (המפתח נכון)');
  }
}

// ── 3. מפתח ה-AI ──
console.log('\nבינה מלאכותית:');
const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
try {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'ענה במילה אחת בלבד: שלום' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 200 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    bad(`Gemini החזיר ${res.status}: ${body.slice(0, 200)}`);
  } else {
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
    if (text) ok(`${model} עונה: "${text}"`);
    else bad(`${model} ענה בלי תוכן — ${JSON.stringify(data).slice(0, 200)}`);
  }
} catch (e) {
  bad(`לא הצלחתי להגיע ל-Gemini: ${e.message}`);
}

console.log(failed
  ? '\n⚠️  יש בעיה — ראה את השורות המסומנות ב-❌\n'
  : '\n🎉 הכל מחובר. אפשר להריץ npm start ולסרוק את ה-QR.\n');
process.exit(failed ? 1 : 0);
