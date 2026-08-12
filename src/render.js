// =====================================================================
//  render.js — כל מה שהבוט כותב בוואטסאפ.
//  כל רשימה מחזירה גם את סדר המשימות, כדי שהמספרים שמוצגים
//  יהיו בדיוק אלה שאפשר לענות עליהם ("1,3" = בוצע).
// =====================================================================
import { rtl, fmtTime, fmtDate, fmtDayName, fmtRelative, daysFromToday, ilParts, HEB_DAYS, HEB_MONTHS } from './util.js';
import { bucket } from './tasks.js';
import { findIssues, summaryLine } from './insights.js';

const SEP = '';
const RULE = '─────────────';

// שורות ההסבר בתחתית כל רשימה.
// כל שורה עומדת בפני עצמה, וכל הדוגמאות משתמשות באותו מספר (1)
// כדי שיהיה חד-משמעי שהמספר הוא מספר המשימה ברשימה שמעל.
// (וואטסאפ מכיר רק *מודגש*, _נטוי_, ~מחוק~ — גרש הפוך יוצג כתו רגיל, אז לא משתמשים בו)
function footer(lines) {
  while (lines.length && lines[lines.length - 1] === SEP) lines.pop();   // בלי רווח כפול
  lines.push(
    SEP,
    rtl(RULE),
    rtl('✔️ *בוצע?* שלח את המספר — 1 (או 1,3 לכמה יחד)'),
    rtl('🕗 *לדחות:* "דחה 1 ליום ראשון"'),
    rtl('🗑️ *למחוק:* "מחק 1"'),
    rtl('❓ *"עזרה"* — כל מה שאני יודע לעשות'),
  );
  return lines;
}

// שורת משימה בודדת
function line(t, n, mode = 'default', now = new Date()) {
  const badges = [];
  if (t.shared && mode !== 'shared') badges.push('👥');   // בתוך המקטע המשותף זה מיותר
  if (t.recurrence) badges.push('🔁');
  const tail = badges.length ? ' ' + badges.join('') : '';

  let prefix = '';
  if (t.due_at) {
    const d = new Date(t.due_at);
    const days = daysFromToday(d, now);
    if (mode === 'overdue') prefix = `${fmtRelative(d, now)} · `;
    else if (mode === 'today') prefix = t.all_day ? '' : `${fmtTime(d)} · `;
    else if (mode === 'week') prefix = t.all_day ? `${fmtDayName(d)} · ` : `${fmtDayName(d)} ${fmtTime(d)} · `;
    else if (mode === 'later') prefix = t.all_day ? `${fmtDate(d)} · ` : `${fmtDate(d)} ${fmtTime(d)} · `;
    else if (days === 0) prefix = t.all_day ? 'היום · ' : `היום ${fmtTime(d)} · `;
    else prefix = `${fmtRelative(d, now)} · `;
  }
  return rtl(`${n}. ${prefix}${t.title}${tail}`);
}

// מקטע ברשימה. order צובר את סדר המשימות, וכל שורה מקבלת את המספר הבא בתור.
function block(title, items, order, mode, now) {
  if (!items.length) return [];
  const out = [rtl(`*${title}* (${items.length})`)];
  for (const t of items) {
    order.push(t.id);
    out.push(line(t, order.length, mode, now));
  }
  return out;
}

// ── סיכום הבוקר ─────────────────────────────────────────────────────
export function renderDigest(user, tasks, opts = {}) {
  const now = opts.now || new Date();
  const p = ilParts(now);
  const order = [];
  const b = bucket(tasks, now);
  const lines = [];

  const hello = opts.evening ? '🌙 *ערב טוב' : '☀️ *בוקר טוב';
  lines.push(rtl(`${hello}, ${user.name}*`));
  lines.push(rtl(`יום ${HEB_DAYS[p.wd]} · ${p.d} ב${HEB_MONTHS[p.m - 1]}`));
  lines.push(rtl(`_${summaryLine(b)}_`));
  lines.push(SEP);

  // המשותף מוצג בנפרד, כדי שיהיה ברור מה "שלנו" ומה "שלי"
  const mine = (arr) => arr.filter((t) => !t.shared);
  const shared = tasks.filter((t) => t.shared);

  lines.push(...block('🔴 באיחור', mine(b.overdue), order, 'overdue', now));
  if (mine(b.overdue).length) lines.push(SEP);

  lines.push(...block('🟠 להיום', mine(b.today), order, 'today', now));
  if (mine(b.today).length) lines.push(SEP);

  if (shared.length) {
    const label = opts.partnerName ? `👥 משותף עם ${opts.partnerName}` : '👥 הרשימה המשותפת';
    lines.push(...block(label, sortForShared(shared, now), order, 'shared', now));
    lines.push(SEP);
  }

  const ahead = [...mine(b.tomorrow), ...mine(b.week)];
  lines.push(...block('🗓️ ממשיך השבוע', ahead, order, 'week', now));
  if (ahead.length) lines.push(SEP);

  if (mine(b.later).length) {
    lines.push(...block('📆 בהמשך', mine(b.later).slice(0, 5), order, 'later', now));
    lines.push(SEP);
  }

  if (mine(b.someday).length) {
    lines.push(...block('💭 מתישהו', mine(b.someday).slice(0, 5), order, 'default', now));
    lines.push(SEP);
  }

  // התרעות — כפילויות, התנגשויות, משימות תקועות
  const refIndex = new Map(order.map((id, i) => [id, i + 1]));
  const issues = findIssues(tasks, refIndex, now);
  if (issues.length) {
    lines.push(rtl('⚠️ *שווה בדיקה*'));
    for (const s of issues) lines.push(rtl(`• ${s}`));
    lines.push(SEP);
  }

  if (!order.length) {
    lines.push(rtl('אין כרגע שום דבר פתוח. תיהנה מזה 😌'));
    lines.push(SEP);
  }

  footer(lines);
  return { text: lines.join('\n'), order };
}

function sortForShared(arr, now) {
  return [...arr].sort((a, b2) => {
    const av = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const bv = b2.due_at ? new Date(b2.due_at).getTime() : Infinity;
    return av - bv;
  });
}

// ── רשימות לפי בקשה ─────────────────────────────────────────────────
export function renderList(user, tasks, filter, opts = {}) {
  const now = opts.now || new Date();
  const b = bucket(tasks, now);
  const order = [];
  const lines = [];

  const push = (title, items, mode) => {
    lines.push(...block(title, items, order, mode, now));
    if (items.length) lines.push(SEP);
  };

  switch (filter) {
    case 'today':
      lines.push(rtl('*🟠 מה יש היום*'));
      lines.push(SEP);
      push('באיחור', b.overdue, 'overdue');
      push('היום', b.today, 'today');
      break;
    case 'tomorrow':
      lines.push(rtl('*🗓️ מחר*'));
      lines.push(SEP);
      push('מחר', b.tomorrow, 'today');
      break;
    case 'overdue':
      lines.push(rtl('*🔴 באיחור*'));
      lines.push(SEP);
      push('באיחור', b.overdue, 'overdue');
      break;
    case 'week':
      lines.push(rtl('*🗓️ השבוע*'));
      lines.push(SEP);
      push('באיחור', b.overdue, 'overdue');
      push('היום', b.today, 'today');
      push('מחר', b.tomorrow, 'today');
      push('בהמשך השבוע', b.week, 'week');
      break;
    case 'shared': {
      const sh = tasks.filter((t) => t.shared);
      lines.push(rtl(opts.partnerName ? `*👥 הרשימה המשותפת עם ${opts.partnerName}*` : '*👥 הרשימה המשותפת*'));
      lines.push(SEP);
      push('משותף', sortForShared(sh, now), 'default');
      break;
    }
    case 'done': {
      const done = opts.doneTasks || [];
      lines.push(rtl('*✅ מה סומן כבוצע לאחרונה*'));
      lines.push(SEP);
      if (!done.length) lines.push(rtl('עוד לא סימנת כלום השבוע.'));
      for (const t of done.slice(0, 20)) {
        lines.push(rtl(`✓ ${t.title}${t.done_at ? ` — ${fmtDate(new Date(t.done_at))}` : ''}`));
      }
      return { text: lines.join('\n'), order: [] };
    }
    case 'all':
    default:
      lines.push(rtl('*📋 כל המשימות הפתוחות*'));
      lines.push(SEP);
      push('🔴 באיחור', b.overdue, 'overdue');
      push('🟠 היום', b.today, 'today');
      push('מחר', b.tomorrow, 'today');       // הכותרת כבר אומרת "מחר" — שם היום מיותר
      push('בהמשך השבוע', b.week, 'week');    // כאן כן, כי זה פרוס על כמה ימים
      push('בהמשך', b.later, 'later');
      push('מתישהו', b.someday, 'default');
      break;
  }

  if (!order.length) lines.push(rtl('אין כאן כלום 🎉'));
  else footer(lines);

  return { text: lines.join('\n'), order };
}

// ── אישורים קצרים ───────────────────────────────────────────────────
export function renderAdded(results, opts = {}) {
  const lines = [];
  const added = results.filter((r) => r.task).map((r) => r.task);
  if (!added.length) return 'לא הצלחתי להבין מה להוסיף. נסה לנסח בקצרה, למשל: "לשלם ארנונה עד יום ראשון".';

  if (added.length === 1) {
    const t = added[0];
    lines.push(rtl(`✅ *${t.title}*`));
    lines.push(rtl(dueLine(t)));
    if (t.shared) lines.push(rtl(`👥 משותף${opts.partnerName ? ` עם ${opts.partnerName}` : ''}`));
    if (t.recurrence) lines.push(rtl(`🔁 ${recurrenceWord(t.recurrence)}`));
  } else {
    lines.push(rtl(`✅ נוספו ${added.length} משימות:`));
    for (const t of added) {
      lines.push(rtl(`• ${t.title} — ${dueLine(t, true)}${t.shared ? ' 👥' : ''}`));
    }
  }

  const warns = results.flatMap((r) => r.warnings || []);
  if (warns.length) {
    lines.push('');
    for (const w of [...new Set(warns)]) lines.push(rtl(`⚠️ ${w}`));
  }
  lines.push('');
  lines.push(rtl('_"ביטול" מבטל · "רשימה" מציג הכל_'));
  return lines.join('\n');
}

function dueLine(t, short = false) {
  if (!t.due_at) return short ? 'בלי תאריך' : '📅 בלי תאריך יעד';
  const d = new Date(t.due_at);
  const rel = fmtRelative(d);
  const when = t.all_day ? `${fmtDayName(d)}, ${fmtDate(d)}` : `${fmtDayName(d)}, ${fmtDate(d)} בשעה ${fmtTime(d)}`;
  const txt = rel === when ? when : `${when} (${rel})`;
  return short ? txt : `📅 ${txt}`;
}

export function recurrenceWord(r) {
  return { daily: 'חוזר כל יום', weekly: 'חוזר כל שבוע', monthly: 'חוזר כל חודש', yearly: 'חוזר כל שנה' }[r] || 'חוזר';
}

export function renderDone(done, repeated, opts = {}) {
  const lines = [];
  if (!done.length) return 'לא מצאתי מה לסמן. שלח "רשימה" כדי לראות את המספרים העדכניים.';
  if (done.length === 1) lines.push(rtl(`✔️ בוצע: *${done[0].title}*`));
  else {
    lines.push(rtl(`✔️ סומנו ${done.length} משימות:`));
    for (const t of done) lines.push(rtl(`• ${t.title}`));
  }
  for (const t of repeated) lines.push(rtl(`🔁 נקבע שוב ל-${dueLine(t, true)}`));
  if (opts.left !== undefined) lines.push(rtl(`_נשארו ${opts.left} משימות פתוחות._`));
  return lines.join('\n');
}

export function renderSnoozed(moved) {
  if (!moved.length) return 'לא מצאתי מה לדחות. שלח "רשימה" כדי לראות מספרים עדכניים.';
  const lines = moved.map(({ task }) => rtl(`🕗 "${task.title}" נדחתה ל-${dueLine(task, true)}`));
  return lines.join('\n');
}

export function renderDeleted(removed) {
  if (!removed.length) return 'לא מצאתי מה למחוק.';
  if (removed.length === 1) return rtl(`🗑️ נמחקה: "${removed[0].title}"`);
  return rtl(`🗑️ נמחקו ${removed.length} משימות.`);
}

export function renderDuplicatePrompt(existing, spec) {
  return [
    rtl('🤔 יש כבר משימה כמעט זהה:'),
    rtl(`• *${existing.title}* — ${dueLine(existing, true)}`),
    '',
    rtl(`רצית להוסיף: "${spec.title}"`),
    rtl('_ענה *כן* כדי להוסיף בכל זאת, או *לא* כדי לוותר._'),
  ].join('\n');
}

export function renderHelp(opts = {}) {
  const p = opts.partnerName || 'בן/בת הזוג';
  return [
    rtl('*🤖 איך מדברים איתי*'),
    '',
    rtl('*להוסיף משימה* — פשוט תכתוב או תקליט:'),
    rtl('_"לשלם ארנונה עד יום ראשון"_'),
    rtl('_"להזמין מתנה לאמא בעוד שבועיים"_'),
    rtl('_"פגישה עם רו״ח מחר ב-14:00"_'),
    rtl('_"להוציא את הכלב כל יום ב-7 בבוקר"_ (חוזר)'),
    '',
    rtl(`*רשימה משותפת עם ${p}* — תוסיף את המילה "משותף":`),
    rtl('_"משותף — להזמין מסעדה ליום שישי"_'),
    '',
    rtl('*לסמן שבוצע* — ענה במספר מהרשימה:'),
    rtl('_"1"_  ·  _"1,3"_  ·  _"סיימתי עם הארנונה"_'),
    '',
    rtl('*פקודות שימושיות:*'),
    rtl('• _רשימה_ — כל מה שפתוח'),
    rtl('• _היום_ / _מחר_ / _השבוע_ / _באיחור_'),
    rtl('• _משותף_ — הרשימה המשותפת'),
    rtl('• _דחה 2 מחר_ / _דחה 2 לשבוע הבא_'),
    rtl('• _מחק 4_'),
    rtl('• _שתף 3_ — הופך משימה קיימת למשותפת'),
    rtl('• _ביטול_ — מבטל את הפעולה האחרונה'),
    rtl('• _סיכום בוקר 07:30_ — משנה את שעת ההודעה היומית'),
    '',
    rtl('_כל בוקר תקבל כאן את הרשימה מסודרת: באיחור, להיום, משותף, והמשך השבוע._'),
  ].join('\n');
}

export function renderReminder(task) {
  const d = new Date(task.due_at);
  return [
    rtl('⏰ *תזכורת*'),
    rtl(`${task.title}`),
    rtl(`_${task.all_day ? 'להיום' : `עכשיו, ${fmtTime(d)}`}_`),
  ].join('\n');
}

export function renderPartnerNotice(actorName, task, kind) {
  if (kind === 'done') return rtl(`✔️ ${actorName} סימן/ה שבוצע: *${task.title}*`);
  if (kind === 'add') return rtl(`👥 ${actorName} הוסיף/ה לרשימה המשותפת: *${task.title}* — ${dueLine(task, true)}`);
  if (kind === 'delete') return rtl(`🗑️ ${actorName} מחק/ה מהרשימה המשותפת: *${task.title}*`);
  return '';
}
