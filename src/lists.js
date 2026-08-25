// =====================================================================
//  lists.js — רשימות ייחוס: מסעדות, ספרים, סרטים, רעיונות למתנות.
//
//  ההבדל מהמשימות הוא לא טכני אלא מהותי: לפריטים כאן אין תאריך יעד,
//  הם לא "מתבצעים", והם לא אמורים להציק. רגע השימוש שלהם הוא השליפה
//  ("איפה לאכול בתל אביב?"), לא ההוספה — ולכן כל ההיגיון כאן בנוי
//  סביב מציאה, לא סביב מעקב.
// =====================================================================
import * as db from './db.js';
import { similarity, normalizeText } from './util.js';

// מיפוי אזורים גס — כדי ש"מסעדות בצפון" ימצא גם את מה שרשום "כרמיאל".
// לא ניסיון להיות GPS, רק לחסוך תסכול בשאילתה הנפוצה.
const REGIONS = {
  'צפון': ['חיפה', 'כרמיאל', 'צפת', 'טבריה', 'עכו', 'נהריה', 'קריות', 'גליל', 'כנרת', 'עמק', 'ראש פינה', 'זכרון', 'עפולה', 'נצרת', 'רמת הגולן', 'גולן'],
  'מרכז': ['תל אביב', 'רמת גן', 'גבעתיים', 'הרצליה', 'רעננה', 'כפר סבא', 'פתח תקווה', 'ראשון לציון', 'חולון', 'בת ים', 'רמת השרון', 'שרון', 'ראש העין', 'מודיעין', 'נס ציונה', 'רחובות'],
  'ירושלים': ['ירושלים', 'מבשרת', 'בית שמש', 'עין כרם'],
  'דרום': ['באר שבע', 'אשדוד', 'אשקלון', 'אילת', 'ערד', 'מצפה רמון', 'נגב', 'שדרות', 'קרית גת', 'ים המלח'],
};

// ── מציאת הרשימה שהמשתמש התכוון אליה ────────────────────────────────
export async function findList(query) {
  const lists = await db.getLists();
  if (!lists.length) return null;
  const q = normalizeText(query);
  if (!q) return null;

  let best = null, bestScore = 0;
  for (const l of lists) {
    const names = [l.name, ...(l.aliases || [])];
    for (const n of names) {
      const nn = normalizeText(n);
      let s = 0;
      if (nn === q) s = 1;
      // "בתי קפה" מול "מסעדות ובתי קפה" — כינוי קצר לשם ארוך, תקין
      else if (nn.includes(q)) s = 0.85;
      // הכיוון ההפוך מסוכן: "מסעדות בתל אביב" מכיל "מסעדות", ואם נקבל
      // אותו כשם הרשימה — הסינון לפי אזור לא יופעל לעולם. מותר רק
      // כשהתוספת זניחה (ה' הידיעה וכדומה).
      else if (q.includes(nn) && q.length <= nn.length + 2) s = 0.8;
      else s = similarity(n, query);
      if (s > bestScore) { bestScore = s; best = l; }
    }
  }
  // סף מחמיר בכוונה: כינוי קצר כמו "קפה" אסור לו לתפוס
  // "קפה איטליה פלורנטין" ולפתוח רשימה במקום לשמור פריט.
  return bestScore >= 0.78 ? best : null;
}

export async function createList(user, name, aliases = [], icon = '📋') {
  const existing = await findList(name);
  if (existing) return { list: existing, existed: true };
  const list = await db.createList({
    name: name.trim(),
    aliases: [...new Set(aliases.map((a) => a.trim()).filter(Boolean))],
    icon,
    owner_id: user.id,
    shared: true,
  });
  return { list, existed: false };
}

// ── הוספת פריט ──────────────────────────────────────────────────────
export async function addItem(user, list, { title, location, area, tags, note }) {
  const clean = String(title || '').trim();
  if (!clean) return { error: 'לא הבנתי מה להוסיף' };

  // כפילות — אותו מקום נוסף פעמיים בטעות
  const items = await db.listItems(list.id);
  const dup = items.find((i) => similarity(i.title, clean) >= 0.8);
  if (dup) return { duplicate: dup };

  const item = await db.createListItem({
    list_id: list.id,
    title: clean,
    location_text: location || null,
    area: normalizeArea(area || location) || null,
    tags: (tags || []).map((t) => String(t).trim()).filter(Boolean),
    note: note || null,
    added_by: user.id,
  });
  return { item };
}

export async function removeItem(itemId) {
  return db.deleteListItem(itemId);
}

// ── שליפה — הלב של העניין ───────────────────────────────────────────
/**
 * מחזיר פריטים מסוננים לפי אזור ו/או תגית, בניסוח חופשי.
 * filter = { area?, tag?, text? }
 */
export async function search(list, filter = {}) {
  let items = await db.listItems(list.id);

  if (filter.area) {
    const want = normalizeText(filter.area);
    const region = REGIONS[Object.keys(REGIONS).find((r) => normalizeText(r) === want)];
    items = items.filter((i) => {
      const hay = normalizeText([i.area, i.location_text].filter(Boolean).join(' '));
      if (!hay) return false;
      if (hay.includes(want)) return true;
      // "בצפון" תופס גם ערים בצפון
      return region ? region.some((c) => hay.includes(normalizeText(c))) : false;
    });
  }

  if (filter.tag) {
    const want = normalizeText(filter.tag);
    items = items.filter((i) => (i.tags || []).some((t) => normalizeText(t).includes(want)));
  }

  if (filter.text) {
    const want = normalizeText(filter.text);
    items = items.filter((i) => normalizeText([i.title, i.location_text, i.note, ...(i.tags || [])].join(' ')).includes(want));
  }

  return items;
}

// "בתל אביב" → "תל אביב" · "ליד הים בחיפה" → "חיפה"
function normalizeArea(text) {
  if (!text) return null;
  const t = String(text).trim();
  for (const [region, cities] of Object.entries(REGIONS)) {
    for (const c of cities) if (t.includes(c)) return c;
    if (t.includes(region)) return region;
  }
  // אין התאמה מוכרת — שומרים את המילים האחרונות כאזור גס
  const words = t.replace(/^ב/, '').split(/[\s,]+/).filter(Boolean);
  return words.slice(-2).join(' ') || null;
}

export { REGIONS };
