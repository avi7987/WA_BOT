// תיבת הרעיונות של אבי — מה שביקש מהבוט ומחכה לטיפול.
//   npm run ideas            — הרעיונות הפתוחים
//   npm run ideas -- --all   — כולל מה שכבר טופל
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const all = process.argv.includes('--all');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await sb.from('pa_requests').select('*').order('created_at');
if (error) {
  console.error('❌', error.message);
  process.exit(1);
}

const rows = all ? data : data.filter((r) => ['new', 'planned'].includes(r.status));
if (!rows.length) {
  console.log(all ? 'התיבה ריקה.' : 'אין רעיונות פתוחים.');
  process.exit(0);
}

const MARK = { new: '💡', planned: '🔨', done: '✅', rejected: '🗑️' };
console.log(`\n${rows.length} רעיונות${all ? '' : ' פתוחים'}:\n`);
for (const r of rows) {
  const when = new Date(r.created_at).toLocaleDateString('he-IL');
  console.log(`${MARK[r.status] || '·'} ${r.body}`);
  console.log(`   ${when}${r.reply ? ` · ${r.reply}` : ''}`);
  if (r.source_text && r.source_text !== r.body) console.log(`   מקור: "${r.source_text}"`);
  console.log();
}
