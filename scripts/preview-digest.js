// מדפיס דוגמה של סיכום הבוקר לטרמינל — כדי לראות איך זה ייראה בוואטסאפ,
// בלי להתחבר לשום דבר.  הרצה:  npm run preview
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'preview';

const { renderDigest } = await import('../src/render.js');
const { makeIL } = await import('../src/util.js');

const now = new Date();
const at = (days, h = 9, m = 0) => {
  const d = new Date(now.getTime() + days * 864e5);
  return makeIL(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m).toISOString();
};

const user = { id: 'u1', name: 'אבישי', session_key: 'owner' };
const tasks = [
  { id: '1', title: 'לשלם ארנונה', due_at: at(-3), all_day: true, shared: false, status: 'open' },
  { id: '2', title: 'להתקשר למוסך', due_at: at(-1), all_day: true, shared: false, status: 'open' },
  { id: '3', title: 'פגישה עם רו״ח', due_at: at(0, 14, 0), all_day: false, shared: false, status: 'open' },
  { id: '4', title: 'לסיים את המצגת', due_at: at(0), all_day: true, shared: false, status: 'open' },
  { id: '5', title: 'לקנות מתנה לאמא', due_at: at(0, 14, 30), all_day: false, shared: false, status: 'open' },
  { id: '6', title: 'להזמין מסעדה ליום שישי', due_at: at(2), all_day: true, shared: true, status: 'open' },
  { id: '7', title: 'לתאם גננת', due_at: at(4), all_day: true, shared: true, status: 'open' },
  { id: '8', title: 'לחדש ביטוח רכב', due_at: at(3), all_day: true, shared: false, status: 'open' },
  { id: '9', title: 'תור לרופא שיניים', due_at: at(5, 16, 0), all_day: false, shared: false, status: 'open' },
  { id: '10', title: 'לשלם את הארנונה', due_at: at(6), all_day: true, shared: false, status: 'open' },
  { id: '11', title: 'להוציא את הכלב', due_at: at(1, 7, 0), all_day: false, shared: false, recurrence: 'daily', status: 'open' },
  { id: '12', title: 'לבדוק אופציות לחופשה', due_at: null, all_day: true, shared: false, status: 'open' },
];

const { text } = renderDigest(user, tasks, { partnerName: 'איה' });
console.log('\n' + '─'.repeat(46));
console.log(text.replace(/‏/g, ''));      // בלי סימני הכיווניות, לקריאות בטרמינל
console.log('─'.repeat(46) + '\n');
