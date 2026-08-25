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

// שורת משימה בודדת.
// opts.nameOf ממפה מזהה-משתמש לשם, כדי לסמן "בטיפול מי" במקטע המשותף.
function line(t, n, mode = 'default', now = new Date(), opts = {}) {
  const badges = [];
  if (t.shared && mode !== 'shared') badges.push('👥');   // בתוך המקטע המשותף זה מיותר
  if (t.recurrence) badges.push('🔁');
  const who = t.assigned_to && opts.nameOf ? opts.nameOf(t.assigned_to) : null;
  // הערות מתקפלות לסימון בלבד — הן כבר נדחפו בזמן אמת כשנכתבו
  const notes = opts.noteCounts?.get(t.id) || 0;
  const msgs = opts.messageCounts?.get(t.id) || 0;
  const tail = (badges.length ? ' ' + badges.join('') : '')
    + (who ? `  👤 ${who}` : '')
    + (notes ? `  💬${notes > 1 ? notes : ''}` : '')
    + (msgs ? '  📤' : '');

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
function block(title, items, order, mode, now, opts = {}) {
  if (!items.length) return [];
  const out = [rtl(`*${title}* (${items.length})`)];
  for (const t of items) {
    order.push(t.id);
    out.push(line(t, order.length, mode, now, opts));
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
    lines.push(...block(label, sortForShared(shared, now, user.id), order, 'shared', now, opts));
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

// במשותף: קודם מה שעליי, אחר כך מה שעל שנינו, ולבסוף מה שבטיפול הצד השני.
// בתוך כל קבוצה — לפי תאריך.
function sortForShared(arr, now, viewerId) {
  const rank = (t) => (t.assigned_to === viewerId ? 0 : !t.assigned_to ? 1 : 2);
  return [...arr].sort((a, b2) => {
    const r = rank(a) - rank(b2);
    if (r) return r;
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
    lines.push(...block(title, items, order, mode, now, opts));
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
      push('משותף', sortForShared(sh, now, user.id), 'shared');
      break;
    }
    case 'mine_assigned': {
      const mine = tasks.filter((t) => t.shared && t.assigned_to === user.id);
      lines.push(rtl('*👤 מה שבטיפולי מהמשותף*'));
      lines.push(SEP);
      push('בטיפולי', sortForShared(mine, now, user.id), 'shared');
      break;
    }
    case 'partner_assigned': {
      const theirs = tasks.filter((t) => t.shared && t.assigned_to && t.assigned_to !== user.id);
      lines.push(rtl(`*👤 מה שבטיפול ${opts.partnerName || 'הצד השני'}*`));
      lines.push(SEP);
      push(`בטיפול ${opts.partnerName || ''}`.trim(), sortForShared(theirs, now, user.id), 'shared');
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
    if (t.shared) {
      const who = t.assigned_to && opts.nameOf ? opts.nameOf(t.assigned_to) : null;
      lines.push(rtl(`👥 משותף${opts.partnerName ? ` עם ${opts.partnerName}` : ''}${who ? ` · בטיפול ${who}` : ''}`));
    }
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
  const already = opts.already || [];

  // מישהו הקדים אותך — אומרים מי ומתי, במקום "לא מצאתי"
  if (!done.length && already.length) {
    return already.map((t) => {
      const who = t.done_by && opts.nameOf ? opts.nameOf(t.done_by) : null;
      const when = t.done_at ? agoText(new Date(t.done_at)) : null;
      return rtl(`✔️ "${t.title}" כבר סומנה כבוצעה${who ? ` ע"י ${who}` : ''}${when ? ` ${when}` : ''}.`);
    }).join('\n');
  }
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
    rtl(`*מה שנוגע ל${p}* — פשוט תנסח את זה טבעי, אני מבין מההקשר:`),
    rtl('_"צריך שמישהו יקנה חלב"_ — נכנס למשותף'),
    rtl(`_"ש${p} תיקח את הדואר מחר"_ — משותף, בטיפול ${p}`),
    rtl(`_"תטיל על ${p} לתאם תור לרופא"_ — משותף, בטיפול ${p}`),
    rtl('_"אני אקח את זה"_ — עובר לטיפול שלך'),
    '',
    rtl('*שלושה אזורים:* מה שאתה כותב סתם נשאר *אישי* ורק אתה רואה אותו.'),
    rtl(`מה שנוגע לשניכם נכנס ל*משותף*. ל${p} יש אזור אישי משלה שאתה לא רואה.`),
    '',
    rtl('*לסמן שבוצע* — ענה במספר מהרשימה:'),
    rtl('_"1"_  ·  _"1,3"_  ·  _"סיימתי עם הארנונה"_'),
    '',
    rtl('*הערות על משימה* — מידע נוסף, בלי להעמיס את הרשימה:'),
    rtl('_"הערה 3: כבר קניתי חלב, צריך רק לחם"_'),
    rtl(`ההערה נשלחת מיד ל${p} אם המשימה משותפת, ואז מתקפלת לסימון 💬 ליד המשימה.`),
    rtl('_"הערות 3"_ — לראות את כל ההערות על משימה'),
    '',
    rtl('*תזכורות* — משימה עם שעה מקבלת תזכורת 15 דקות לפני,'),
    rtl('ואפשר לענות עליה: _1_ = בוצע · _2_ = דחה בשעה · _3_ = דחה למחר'),
    '',
    rtl('*הודעות לאנשים אחרים* — נשלחות רק אחרי שאתה מאשר:'),
    rtl('_"תכין הודעה ליוסי האינסטלטור: היי, אפשר לקבוע לשבוע הבא?"_'),
    rtl('במועד תקבל את ההודעה המדויקת לאישור, עם השם והמספר של הנמען.'),
    rtl('_1 = שלח · 2 = ערוך · 3 = בטל · 4 = דחה בשעה_'),
    rtl('משימה עם הודעה ממתינה מסומנת ב-📤.'),
    rtl('_"הודעות"_ · _"הודעה 3"_ · _"בטל הודעה 3"_ · _"נשלחו היום"_'),
    '',
    rtl('*רשימות ייחוס* — דברים ששווה לזכור, בלי תאריך ובלי הצקה:'),
    rtl('_"תוסיף למסעדות: קפה איטליה, פלורנטין תל אביב, בשרי"_'),
    rtl('_"מסעדות"_ · _"מסעדות בתל אביב"_ · _"איפה לאכול בצפון"_'),
    rtl('_"תמחק מהמסעדות 2"_ · _"תפתח רשימה של ספרים"_ · _"רשימות"_'),
    rtl('הן *לא* מופיעות בסיכום הבוקר ולא ברשימת המשימות — רק כשתבקש.'),
    '',
    rtl('*זימונים ביומן* — המילה "זימון" מפעילה את זה:'),
    rtl('_"תייצר זימון לפגישה עם רו״ח מחר ב-14:00, תוסיף גם את איה"_'),
    rtl('_"זימון לביקור אצל ההורים ביום שישי"_ — בלי שעה, נכנס כיום שלם טנטטיבי'),
    rtl('_"זימונים"_ · _"תבטל את הזימון"_'),
    '',
    rtl('*תיבת רעיונות* — משהו שהיית רוצה שאדע לעשות:'),
    rtl('_"רעיון: תוסיף אפשרות לצרף תמונות"_ · _"באג: התזכורת הגיעה פעמיים"_'),
    rtl('נשמר ולא הולך לאיבוד. _"רעיונות"_ מציג את התיבה.'),
    rtl('אם מה שביקשת כבר אפשרי — אגיד לך איך, במקום לרשום רעיון מיותר.'),
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

/**
 * תזכורת עם תשובות ממוספרות.
 * וואטסאפ לא מאפשר לחצנים דרך חיבור מכשיר-מקושר (זו תכונה של ה-API
 * העסקי הרשמי), אז מספרים הם התחליף הקרוב ביותר במספר ההקשות.
 */
export function renderReminder(task, opts = {}) {
  const d = task.due_at ? new Date(task.due_at) : null;
  const lead = opts.leadMinutes;
  const when = !d ? ''
    : lead > 0 ? `בעוד ${lead} דקות · ${fmtTime(d)}`
      : `עכשיו · ${fmtTime(d)}`;
  const lines = [
    rtl('⏰ *תזכורת*'),
    rtl(`*${task.title}*`),
  ];
  if (when) lines.push(rtl(`_${when}_`));
  if (opts.assignedName) lines.push(rtl(`_בטיפול ${opts.assignedName}_`));
  lines.push(SEP);
  lines.push(rtl('1 = בוצע   2 = דחה בשעה   3 = דחה למחר'));
  return lines.join('\n');
}

export function renderPartnerNotice(actorName, task, kind) {
  if (kind === 'done') return rtl(`✔️ ${actorName} סימן/ה שבוצע: *${task.title}*`);
  if (kind === 'add') return rtl(`👥 ${actorName} הוסיף/ה לרשימה המשותפת: *${task.title}* — ${dueLine(task, true)}`);
  if (kind === 'delete') return rtl(`🗑️ ${actorName} מחק/ה מהרשימה המשותפת: *${task.title}*`);
  if (kind === 'snooze') return rtl(`🕗 ${actorName} דחה/תה את *${task.title}* ל-${dueLine(task, true)}`);
  return '';
}

// ── הערות ───────────────────────────────────────────────────────────
export function renderNotes(task, notes, opts = {}) {
  if (!notes.length) return rtl(`אין הערות על "${task.title}".`);
  const lines = [rtl(`💬 *${task.title}*`), SEP];
  for (const n of notes) {
    const who = n.author_id && opts.nameOf ? opts.nameOf(n.author_id) : null;
    const when = n.created_at ? agoText(new Date(n.created_at)) : '';
    lines.push(rtl(`• ${n.body}`));
    lines.push(rtl(`  _${[who, when].filter(Boolean).join(' · ')}_`));
  }
  return lines.join('\n');
}

export function renderNoteAdded(task, opts = {}) {
  const n = opts.count || 1;
  return rtl(`💬 ההערה נשמרה על "${task.title}"${n > 1 ? ` (${n} הערות)` : ''}.`);
}

// הערה חדשה שהצד השני כתב — נדחפת מיד, כדי שלא תתגלה מאוחר מדי
export function renderNoteFromPartner(actorName, task, body) {
  return [
    rtl(`💬 *${actorName} הוסיף/ה הערה*`),
    rtl(`על: ${task.title}`),
    '',
    rtl(`"${body}"`),
  ].join('\n');
}

// ── הודעות יוצאות ───────────────────────────────────────────────────
const fmtPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '').replace(/^972/, '0');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
};

/**
 * כרטיס האישור. שלושה דברים חייבים להופיע כאן תמיד:
 * השם, המספר המלא, והטקסט המדויק — כדי שאפשר יהיה לתפוס
 * "הנמען הלא נכון" לפני השליחה ולא אחריה.
 */
export function renderApprovalRequest(msg, task) {
  return [
    rtl('📤 *מוכן לשליחה — צריך את אישורך*'),
    SEP,
    rtl(`אל: *${msg.to_name || 'לא מזוהה'}*`),
    rtl(`    ${fmtPhone(msg.to_phone)}`),
    task ? rtl(`בקשר ל: ${task.title}`) : null,
    SEP,
    rtl('┄┄┄┄┄┄┄┄┄┄┄┄┄'),
    rtl(msg.body),
    rtl('┄┄┄┄┄┄┄┄┄┄┄┄┄'),
    SEP,
    rtl('1 = שלח   2 = ערוך   3 = בטל   4 = דחה בשעה'),
  ].filter(Boolean).join('\n');
}

export function renderMessageDraft(msg, task) {
  const when = msg.send_at ? `תוצע לאישור ב-${fmtDayName(new Date(msg.send_at))}, ${fmtTime(new Date(msg.send_at))}` : 'ידני — תישלח רק כשתבקש';
  const state = { draft: 'טיוטה', scheduled: 'מתוזמנת', awaiting_approval: 'ממתינה לאישורך' }[msg.status] || msg.status;
  return [
    rtl(`📤 *הודעה ל${msg.to_name || fmtPhone(msg.to_phone)}*`),
    rtl(`    ${fmtPhone(msg.to_phone)}`),
    task ? rtl(`בקשר ל: ${task.title}`) : null,
    SEP,
    rtl(`"${msg.body}"`),
    SEP,
    rtl(`_${state} · ${when}_`),
    rtl('_"שלח הודעה N" · "שנה הודעה N: ..." · "בטל הודעה N"_'),
  ].filter(Boolean).join('\n');
}

export function renderMessageAttached(msg, opts = {}) {
  const when = msg.send_at
    ? `תוצע לאישורך ב-${fmtDayName(new Date(msg.send_at))} ${fmtTime(new Date(msg.send_at))}`
    : 'תישלח רק כשתבקש';
  return [
    rtl(`📤 הודעה מוכנה ל*${msg.to_name || fmtPhone(msg.to_phone)}* (${fmtPhone(msg.to_phone)})`),
    rtl(`"${msg.body}"`),
    rtl(`_${when} · שום דבר לא נשלח בלי אישורך_`),
  ].join('\n');
}

export function renderSent(msg) {
  return rtl(`✅ נשלח ל*${msg.to_name || fmtPhone(msg.to_phone)}*: "${msg.body}"`);
}

export function renderExpired(msg, hours) {
  return [
    rtl(`⏳ ההודעה ל*${msg.to_name || fmtPhone(msg.to_phone)}* *לא נשלחה*.`),
    rtl(`חלפו ${hours} שעות בלי אישור, אז החזרתי אותה לטיוטה.`),
    rtl('_"הודעות" כדי לראות מה ממתין._'),
  ].join('\n');
}

export function renderHeldForQuietHours(msg) {
  return rtl(`🌙 מאושר, אבל עכשיו שעת שקט — ההודעה ל${msg.to_name || fmtPhone(msg.to_phone)} תוצע לך שוב בבוקר.`);
}

export function renderMessageList(rows, tasksById) {
  if (!rows.length) return rtl('אין הודעות ממתינות.');
  const lines = [rtl('📤 *הודעות ממתינות*'), SEP];
  rows.forEach((m, i) => {
    const t = tasksById.get(m.task_id);
    const state = { draft: 'טיוטה', scheduled: 'מתוזמנת', awaiting_approval: '⚠️ ממתינה לאישורך' }[m.status] || m.status;
    lines.push(rtl(`${i + 1} · אל ${m.to_name || fmtPhone(m.to_phone)} — ${state}`));
    lines.push(rtl(`   "${m.body.slice(0, 70)}${m.body.length > 70 ? '…' : ''}"`));
    if (t) lines.push(rtl(`   _${t.title}_`));
  });
  return lines.join('\n');
}

export function renderContactChoice(query, contacts) {
  const lines = [rtl(`🔍 מצאתי כמה תחת "${query}". למי לשלוח?`), SEP];
  contacts.forEach((c, i) => lines.push(rtl(`${i + 1} · ${c.name} — ${fmtPhone(c.phone)}`)));
  lines.push(SEP, rtl('_ענה במספר, או "בטל"._'));
  return lines.join('\n');
}

export function renderSentToday(rows) {
  if (!rows.length) return rtl('לא נשלחו היום הודעות.');
  const lines = [rtl(`📤 *נשלחו היום* (${rows.length})`), SEP];
  for (const r of rows) {
    lines.push(rtl(`• ${fmtTime(new Date(r.sent_at))} — ${r.to_name || fmtPhone(r.to_phone)}`));
    lines.push(rtl(`  "${r.body.slice(0, 60)}${r.body.length > 60 ? '…' : ''}"`));
  }
  return lines.join('\n');
}

// ── זימונים ביומן ───────────────────────────────────────────────────
function eventWhen(ev) {
  const d = new Date(ev.starts_at);
  if (ev.all_day) return `${fmtDayName(d)}, ${fmtDate(d)} · כל היום (טנטטיבי)`;
  const end = ev.ends_at ? new Date(ev.ends_at) : null;
  return `${fmtDayName(d)}, ${fmtDate(d)} · ${fmtTime(d)}${end ? `–${fmtTime(end)}` : ''}`;
}

export function renderEventCreated(ev, opts = {}) {
  const lines = [
    rtl('📅 *נוסף ליומן*'),
    rtl(`*${ev.title}*`),
    rtl(eventWhen(ev)),
  ];
  if (ev.location) lines.push(rtl(`📍 ${ev.location}`));
  if ((ev.guests || []).length) lines.push(rtl(`👥 הוזמנו: ${ev.guests.join(', ')}`));
  if (ev.html_link) { lines.push(SEP); lines.push(rtl(ev.html_link)); }
  lines.push(SEP);
  lines.push(rtl('_"תבטל את הזימון" מבטל אותו ומודיע למוזמנים._'));
  if (opts.warning) lines.push(rtl(`_${opts.warning}_`));
  return lines.join('\n');
}

// כשהיומן לא מחובר — קישור בלחיצה אחת, כדי שהפיצ'ר שימושי בכל מקרה
export function renderEventLink(ev, link) {
  return [
    rtl('📅 *מוכן ליומן*'),
    rtl(`*${ev.title}*`),
    rtl(eventWhen(ev)),
    (ev.guests || []).length ? rtl(`👥 ${ev.guests.join(', ')}`) : null,
    SEP,
    rtl(link),
    SEP,
    rtl('_לחיצה תפתח את יומן גוגל עם הכל מוכן — רק לשמור._'),
    rtl('_(לחיבור אוטומטי מלא, בלי הלחיצה הזו — תגיד לי ונחבר את היומן.)_'),
  ].filter(Boolean).join('\n');
}

export function renderEventCancelled(ev) {
  return rtl(`🗑️ הזימון "${ev.title}" בוטל${(ev.guests || []).length ? ' והמוזמנים עודכנו' : ''}.`);
}

export function renderEvents(events) {
  if (!events.length) return rtl('אין זימונים שיצרתי לאחרונה.');
  const lines = [rtl(`📅 *זימונים אחרונים* (${events.length})`), SEP];
  events.forEach((ev, i) => {
    lines.push(rtl(`${i + 1}. *${ev.title}* — ${eventWhen(ev)}`));
    if ((ev.guests || []).length) lines.push(rtl(`   _${ev.guests.join(', ')}_`));
  });
  lines.push(SEP);
  lines.push(rtl('_"תבטל זימון 2"_'));
  return lines.join('\n');
}

// ── "לאן זה שייך?" ──────────────────────────────────────────────────
// מוצג רק כשבאמת לא ברור. תיוק שקט במקום הלא נכון גרוע משאלה קצרה.
export function renderDestinationChoice(text, listName) {
  const lines = [
    rtl(`🤔 *"${text}"*`),
    rtl('לאן לשייך את זה?'),
    SEP,
    rtl('1 · משימה שלי'),
  ];
  if (listName) lines.push(rtl(`2 · ${listName}`));
  lines.push(rtl(`${listName ? 3 : 2} · רעיון לפיתוח הבוט`));
  lines.push(SEP);
  lines.push(rtl('_ענה במספר, או "בטל"._'));
  return lines.join('\n');
}

// ── תיבת רעיונות ────────────────────────────────────────────────────
export function renderIdeaSaved(req, count) {
  return [
    rtl('💡 *נרשם.*'),
    rtl(`"${req.body}"`),
    '',
    rtl(`_${count === 1 ? 'זה הרעיון הראשון בתיבה' : `${count} רעיונות ממתינים`} · "רעיונות" כדי לראות._`),
  ].join('\n');
}

export function renderIdeas(reqs) {
  if (!reqs.length) {
    return [
      rtl('💡 *תיבת הרעיונות ריקה.*'),
      SEP,
      rtl('_כשעולה לך רעיון לשיפור — "רעיון: ..." ואשמור אותו._'),
    ].join('\n');
  }
  const lines = [rtl(`💡 *תיבת הרעיונות* (${reqs.length})`), SEP];
  reqs.forEach((r, i) => {
    const mark = r.status === 'planned' ? ' 🔨' : '';
    lines.push(rtl(`${i + 1}. ${r.body}${mark}`));
    if (r.reply) lines.push(rtl(`   _${r.reply}_`));
  });
  lines.push(SEP);
  lines.push(rtl(RULE));
  lines.push(rtl('_"רעיון בוצע 2" · "מחק רעיון 3"_'));
  lines.push(rtl('_🔨 = בעבודה_'));
  return lines.join('\n');
}

// כשמבקשים משהו שהבוט כבר יודע לעשות — עדיף לומר את זה מאשר לרשום רעיון
export function renderAlreadySupported(explanation) {
  return [
    rtl('✨ *זה כבר אפשרי.*'),
    '',
    rtl(explanation),
    '',
    rtl('_אם התכוונת למשהו אחר — תנסח שוב ואשמור כרעיון._'),
  ].join('\n');
}

// ── רשימות ייחוס ────────────────────────────────────────────────────
export function renderListItems(list, items, filter = {}) {
  const scope = [filter.area && `· ${filter.area}`, filter.tag && `· ${filter.tag}`].filter(Boolean).join(' ');
  const lines = [rtl(`${list.icon || '📋'} *${list.name}*${scope ? ' ' + scope : ''} (${items.length})`), SEP];

  if (!items.length) {
    lines.push(rtl(filter.area || filter.tag
      ? 'אין כאן משהו שמתאים לסינון הזה.'
      : 'הרשימה ריקה עדיין.'));
    lines.push(SEP);
    lines.push(rtl(`_להוסיף: "תוסיף ל${list.name}: שם המקום, מיקום"_`));
    return lines.join('\n');
  }

  items.forEach((it, i) => {
    const where = it.location_text || it.area;
    lines.push(rtl(`${i + 1}. *${it.title}*${where ? ` — ${where}` : ''}`));
    const extras = [(it.tags || []).join(' · '), it.note].filter(Boolean).join(' | ');
    if (extras) lines.push(rtl(`   _${extras}_`));
  });

  lines.push(SEP);
  lines.push(rtl(RULE));
  lines.push(rtl(`_"תוסיף ל${list.name}: ..." · "תמחק מ${list.name} 2"_`));
  return lines.join('\n');
}

export function renderListsOverview(lists, counts) {
  if (!lists.length) return rtl('אין עדיין רשימות. אפשר לפתוח אחת: _"תפתח רשימה של ספרים"_.');
  const lines = [rtl('📚 *הרשימות שלך*'), SEP];
  for (const l of lists) {
    lines.push(rtl(`${l.icon || '📋'} *${l.name}* — ${counts.get(l.id) || 0} פריטים`));
  }
  lines.push(SEP);
  lines.push(rtl('_כדי לפתוח אחת, פשוט תכתוב את שמה._'));
  lines.push(rtl('_הרשימות האלה לא מופיעות בסיכום הבוקר ולא ברשימת המשימות._'));
  return lines.join('\n');
}

export function renderItemAdded(list, item) {
  const lines = [rtl(`${list.icon || '📋'} נוסף ל*${list.name}*: *${item.title}*`)];
  if (item.location_text || item.area) lines.push(rtl(`📍 ${item.location_text || item.area}`));
  if ((item.tags || []).length) lines.push(rtl(`🏷️ ${item.tags.join(' · ')}`));
  return lines.join('\n');
}

export function renderItemRemoved(list, item) {
  return rtl(`🗑️ "${item.title}" הוסר מ${list.name}.`);
}

export function renderItemDuplicate(list, existing) {
  const where = existing.location_text || existing.area;
  return rtl(`כבר יש ב${list.name}: *${existing.title}*${where ? ` — ${where}` : ''}`);
}

// ── שאלת הבהרה ──────────────────────────────────────────────────────
export function renderDisambiguation(query, candidates, verb) {
  const lines = [rtl(`🤔 יש כמה שמתאימות ל"${query}". על איזו התכוונת?`), SEP];
  candidates.forEach((t, i) => {
    lines.push(rtl(`${i + 1} · ${t.title}${t.due_at ? ` — ${dueLine(t, true)}` : ''}`));
  });
  lines.push(SEP);
  lines.push(rtl(`_ענה במספר, או "בטל" כדי לוותר._${verb ? ` _(${verb})_` : ''}`));
  return lines.join('\n');
}

// משימה משותפת שהוטלה עליך
export function renderAssignedToYou(actorName, task) {
  return [
    rtl(`📥 *${actorName} הטיל/ה עליך משימה*`),
    rtl(`${task.title}`),
    rtl(dueLine(task)),
    '',
    rtl('_היא נמצאת ברשימה המשותפת שלכם. ענה במספר שלה כשתסיים._'),
  ].join('\n');
}

// המשימה שהטלת בוצעה
export function renderAssignedDone(doerName, task) {
  return rtl(`✅ ${doerName} סיים/ה את המשימה שהטלת: *${task.title}*`);
}

export function renderAssigned(changed, opts = {}) {
  if (!changed.length) return 'לא מצאתי את המשימה.';
  return changed.map(({ task }) => {
    const who = task.assigned_to && opts.nameOf ? opts.nameOf(task.assigned_to) : null;
    return rtl(who
      ? `👤 "${task.title}" — בטיפול ${who} (ברשימה המשותפת)`
      : `👥 "${task.title}" חזרה להיות על שניכם`);
  }).join('\n');
}

// "לפני 3 דקות" / "לפני שעתיים" / "אתמול"
function agoText(date, now = new Date()) {
  const min = Math.round((now - date) / 60000);
  if (min < 1) return 'ממש עכשיו';
  if (min === 1) return 'לפני דקה';
  if (min < 60) return `לפני ${min} דקות`;
  const hrs = Math.round(min / 60);
  if (hrs === 1) return 'לפני שעה';
  if (hrs === 2) return 'לפני שעתיים';
  if (hrs < 24) return `לפני ${hrs} שעות`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'אתמול' : `לפני ${days} ימים`;
}
