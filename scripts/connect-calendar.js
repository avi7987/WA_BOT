// חיבור חד-פעמי ליומן גוגל.  הרצה:  npm run calendar
//
// רץ במחשב שלך (לא בשרת), פותח דפדפן לאישור, ומדפיס refresh token
// שמעתיקים ל-.env. מרגע זה השרת יוצר אירועים לבד.
import 'dotenv/config';
import http from 'http';
import { exec } from 'child_process';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 5599;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
❌ חסרים GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET בקובץ .env

לפני שמריצים את זה:
  1. console.cloud.google.com → New Project (שם: tasks-bot)
  2. APIs & Services → Library → "Google Calendar API" → Enable
  3. APIs & Services → OAuth consent screen:
     • User type: External → Create
     • App name: tasks-bot, ומייל שלך בשני השדות
     • Scopes → Add → calendar.events
     • ⚠️ בסיום — Publishing status → PUBLISH APP → In production
       (בלי זה הטוקן יפוג אחרי 7 ימים!)
  4. Credentials → Create Credentials → OAuth client ID
     • Application type: Web application
     • Authorized redirect URIs → ${REDIRECT}
  5. מעתיקים Client ID ו-Client Secret ל-.env
`);
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',              // חובה — בלי זה לא נקבל refresh token
});

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) { res.writeHead(400).end('missing code'); return; }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT, grant_type: 'authorization_code',
    }),
  });
  const data = await r.json();

  if (!data.refresh_token) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<h2 dir="rtl">לא התקבל refresh token. נסה שוב.</h2>');
    console.error('\n❌ לא התקבל refresh_token:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end('<h2 dir="rtl">✅ היומן חובר. אפשר לסגור את החלון ולחזור לטרמינל.</h2>');

  console.log('\n✅ הצליח! הוסף לקובץ .env (גם במחשב וגם בשרת):\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`);
  console.log('⚠️  ודא שב-Google Cloud → OAuth consent screen הסטטוס הוא');
  console.log('   "In production" ולא "Testing" — אחרת הטוקן יפוג בעוד 7 ימים.\n');
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log('\n🌐 נפתח דפדפן לאישור. אם לא נפתח — פתח ידנית:\n');
  console.log(authUrl + '\n');
  const open = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${open} "${authUrl}"`);
});
