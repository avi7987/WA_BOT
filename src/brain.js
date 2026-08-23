// =====================================================================
//  brain.js — המוח: הודעה נכנסת → פעולה → תשובה.
//
//  סדר העבודה:
//   1. אם יש שאלת אישור פתוחה ("להוסיף בכל זאת?") — עונים לה קודם.
//   2. פקודה מהירה (מספר, "דחה", "רשימה") — מטופלת מיד, בלי AI.
//   3. כל השאר — עובר ל-LLM שמחזיר פעולות מובנות.
//   4. אין AI / ה-AI נפל — נופלים לפרסר המקומי (parse.js).
// =====================================================================
import * as db from './db.js';
import * as T from './tasks.js';
import * as R from './render.js';
import * as llm from './llm.js';
import * as OB from './outbound.js';
import { parseCommand, parseTaskFallback, extractDue, mentionsTime } from './parse.js';
import { rtl as rtlLine } from './util.js';

const PENDING_TTL_MS = 15 * 60e3;

// אפשרויות תצוגה משותפות לכל הרינדורים: שם בן/בת הזוג, ומיפוי מזהה→שם
// כדי שאפשר יהיה לכתוב "בטיפול איה" במקום מזהה טכני.
function viewOpts(user, deps) {
  const partner = deps.partnerOf(user);
  return {
    partnerName: partner?.name || null,
    nameOf: (id) => (id === user.id ? user.name : (partner && id === partner.id ? partner.name : null)),
  };
}

// "me" / "partner" → מזהה משתמש אמיתי
function assigneeId(user, deps, who) {
  if (who === 'me' || who === user.name) return user.id;
  if (who === 'partner') return deps.partnerOf(user)?.id || null;
  const partner = deps.partnerOf(user);
  if (partner && who === partner.name) return partner.id;
  return null;
}

/**
 * deps = {
 *   partnerOf(user) -> user|null,
 *   notify(user, text) -> Promise    // שולח הודעה לאדם אחר בצ'אט שלו
 * }
 * מחזיר את הטקסט שצריך להשיב לשולח.
 */
export async function handleMessage(user, rawText, deps, opts = {}) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const prefix = opts.heard ? `🎧 _שמעתי:_ "${opts.heard}"\n\n` : '';
  const body = await route(user, text, deps);
  return body ? prefix + body : null;
}

async function route(user, text, deps) {
  const cmd = parseCommand(text);

  // ── 1. שאלה פתוחה ממתינה ──
  // עיקרון אחיד: כל שאלה שהבוט שואל נענית במספר (או כן/לא).
  const st = await db.getState(user.id);
  const pending = validPending(st.pending);
  if (pending) {
    const handled = await handlePending(user, pending, text, cmd, deps);
    if (handled !== null) return handled;
    await db.clearPending(user.id);   // המשתמש עבר לנושא אחר
  } else if (st.pending) {
    await db.clearPending(user.id);
  }

  // ── 2. פקודות מהירות ──
  if (cmd) {
    // "כן"/"לא" בלי שאלה פתוחה — לא הופכים את זה למשימה בשם "כן"
    if (cmd.kind === 'yes' || cmd.kind === 'no') {
      return 'אין לי כרגע שאלה פתוחה 🙂 אפשר לכתוב לי משימה חדשה, או "רשימה".';
    }
    const out = await handleCommand(user, cmd, deps);
    if (out) return out;
  }

  // ── 3. הבנה חופשית ──
  const ordered = await orderedTasks(user);
  const partner = deps.partnerOf(user);
  const parsed = await llm.interpret(text, {
    tasks: ordered,
    userId: user.id,
    userName: user.name,
    partnerName: partner?.name || null,
    defaultShared: !!user.default_shared,
  });

  if (parsed?.actions?.length) return execActions(user, parsed, text, deps);

  // ── 4. גיבוי מקומי ──
  const spec = parseTaskFallback(text, new Date(), {
    ownerName: user.name,
    partnerName: partner?.name || null,
  });
  spec.assigned_to = assigneeId(user, deps, spec.assign);
  if (spec.assigned_to) spec.shared = true;
  if (user.default_shared) spec.shared = true;
  spec.source_text = text;
  const res = await addOne(user, spec, deps);
  if (res.pendingPrompt) return res.pendingPrompt;
  return R.renderAdded([res], viewOpts(user, deps));
}

// ── פקודות מהירות ───────────────────────────────────────────────────
async function handleCommand(user, cmd, deps) {
  const partner = deps.partnerOf(user);

  switch (cmd.kind) {
    case 'help':
      return R.renderHelp({ partnerName: partner?.name });

    case 'undo': {
      const la = await T.undoLast(user);
      if (!la) return 'אין מה לבטל.';
      const words = { add: 'ההוספה בוטלה', complete: 'החזרתי לרשימה', delete: 'שחזרתי', snooze: 'החזרתי את התאריך הקודם', share: 'החזרתי את מצב השיתוף', assign: 'החזרתי את השיוך הקודם' };
      return `↩️ ${words[la.kind] || 'בוטל'}.`;
    }

    case 'list': {
      const tasks = await db.openTasksFor(user);
      const doneTasks = cmd.filter === 'done' ? await db.recentlyDone(user) : null;
      const ids = tasks.map((t) => t.id);
      const o = { ...viewOpts(user, deps), doneTasks, noteCounts: await db.noteCounts(ids), messageCounts: await db.messageCounts(ids) };
      const view = cmd.filter === 'digest'
        ? R.renderDigest(user, tasks, o)
        : R.renderList(user, tasks, cmd.filter, o);
      await db.setRefs(user.id, view.order);
      return view.text;
    }

    case 'done': {
      const { ids, missing } = await T.resolveRefs(user, cmd.refs);
      const { done, repeated, already } = await T.completeTasks(user, ids);
      await notifyShared(user, done, 'done', deps);
      await notifyAssigner(user, done, deps);
      const left = (await db.openTasksFor(user)).length;
      let out = R.renderDone(done, repeated, { left, already, ...viewOpts(user, deps) });
      if (missing.length) out += `\n_לא מצאתי מספר ${missing.join(', ')} — שלח "רשימה" לרענון._`;
      return out;
    }

    case 'snooze': {
      const { ids, missing } = await T.resolveRefs(user, cmd.refs);
      const parsedWhen = extractDue(cmd.when || 'מחר');
      const due = parsedWhen.due || T.tomorrowMorning();
      const moved = await T.snoozeTasks(user, ids, due, parsedWhen.allDay);
      let out = R.renderSnoozed(moved);
      if (missing.length) out += `\n_לא מצאתי מספר ${missing.join(', ')}._`;
      return out;
    }

    case 'delete': {
      const { ids } = await T.resolveRefs(user, cmd.refs);
      const removed = await T.deleteTasks(user, ids);
      await notifyShared(user, removed, 'delete', deps);
      return R.renderDeleted(removed);
    }

    case 'share': {
      const { ids } = await T.resolveRefs(user, cmd.refs);
      const changed = await T.setShared(user, ids, cmd.shared);
      if (!changed.length) return 'לא מצאתי את המשימה.';
      if (cmd.shared) {
        await notifyShared(user, changed, 'add', deps);
        return `👥 ${changed.length === 1 ? `"${changed[0].title}" עברה` : `${changed.length} משימות עברו`} לרשימה המשותפת${partner ? ` עם ${partner.name}` : ''}.`;
      }
      return `🔒 ${changed.length === 1 ? `"${changed[0].title}" חזרה` : `${changed.length} משימות חזרו`} להיות פרטיות.`;
    }

    case 'note_add': {
      const { ids } = await T.resolveRefs(user, [cmd.ref]);
      if (!ids.length) return 'לא מצאתי את המשימה. שלח "רשימה" לרענון המספרים.';
      return addNoteTo(user, ids[0], cmd.text, deps);
    }

    case 'note_show': {
      const { ids } = await T.resolveRefs(user, [cmd.ref]);
      if (!ids.length) return 'לא מצאתי את המשימה. שלח "רשימה" לרענון המספרים.';
      return applyVerb(user, 'note_show', {}, ids, deps);
    }

    // ── הודעות יוצאות ──
    case 'msg_list': {
      const rows = await db.messagesAwaiting(user.id);
      const all = await db.openTasksFor(user);
      const live = [];
      for (const t of all) live.push(...await db.messagesForTask(t.id));
      const byId = new Map(all.map((t) => [t.id, t]));
      return R.renderMessageList(live.length ? live : rows, byId);
    }

    case 'msg_sent_today':
      return R.renderSentToday(await db.sentToday());

    case 'msg_show': {
      const r = await messageOfTaskRef(user, cmd.ref);
      if (r.error) return r.error;
      return R.renderMessageDraft(r.msg, await db.getTask(r.taskId));
    }

    case 'msg_cancel': {
      const r = await messageOfTaskRef(user, cmd.ref);
      if (r.error) return r.error;
      await OB.cancel(user, r.msg.id);
      return `🗑️ ההודעה ל${r.msg.to_name || r.msg.to_phone} בוטלה. המשימה נשארה.`;
    }

    case 'msg_edit': {
      const r = await messageOfTaskRef(user, cmd.ref);
      if (r.error) return r.error;
      const updated = await OB.edit(user, r.msg.id, cmd.text);
      return R.renderMessageDraft(updated, await db.getTask(r.taskId));
    }

    case 'msg_send': {
      const r = await messageOfTaskRef(user, cmd.ref);
      if (r.error) return r.error;
      await OB.askApproval(user, r.msg, { ...deps, sendTo: async () => {} });
      return R.renderApprovalRequest(r.msg, await db.getTask(r.taskId));
    }

    // שליחת מבחן — ההודעה נשלחת אליך, בדיוק כפי שתיראה אצל הנמען
    case 'msg_test': {
      const r = await messageOfTaskRef(user, cmd.ref);
      if (r.error) return r.error;
      return `🧪 ככה זה ייראה אצל ${r.msg.to_name || r.msg.to_phone}:\n\n${r.msg.body}`;
    }

    case 'digest_time': {
      await db.upsertUser(user.session_key, { digest_time: cmd.time });
      user.digest_time = cmd.time;
      return `⏰ מעכשיו הסיכום היומי יגיע ב-${cmd.time}.`;
    }

    case 'yes':
    case 'no':
      return null;      // אין שאלה פתוחה — שיעבור ל-AI

    default:
      return null;
  }
}

// ── ביצוע פעולות שה-LLM החזיר ───────────────────────────────────────
async function execActions(user, parsed, sourceText, deps) {
  const partner = deps.partnerOf(user);
  const addResults = [];
  const dupSpecs = [];
  const outputs = [];

  for (const a of parsed.actions) {
    try {
      switch (a.type) {
        case 'add': {
          // בלם על ה-AI: הוא מחזיר לפעמים שעה מדויקת (09:00) גם כשלא נאמרה שעה.
          // אם בטקסט המקורי אין שום אזכור של שעה — זו משימה ליום שלם.
          const timed = a.all_day === false && mentionsTime(sourceText);
          const assigned = assigneeId(user, deps, a.assign);
          const spec = {
            title: a.title,
            due_at: normDue(a.due),
            all_day: !timed,
            // שיוך גורר שיתוף — אין שיוך בתוך אזור אישי
            shared: a.shared === true || !!assigned || (user.default_shared && a.shared !== false),
            assigned_to: assigned,
            recurrence: a.recurrence || null,
            notes: a.notes || null,
            source_text: sourceText,
          };
          if (!spec.title) break;
          const res = await T.addTask(user, spec);
          if (res.duplicate) { dupSpecs.push({ spec, existing: res.duplicate }); break; }
          addResults.push(res);
          if (res.task?.shared) await notifyShared(user, [res.task], 'add', deps);
          if (res.task?.assigned_to) await notifyAssignment(user, [res.task], deps);
          break;
        }
        case 'compose_message': {
          const taskId = a.ref === 'new' || a.ref == null
            ? (addResults[addResults.length - 1]?.task?.id || null)
            : (await T.resolveRefs(user, [a.ref])).ids[0];
          if (!taskId) { outputs.push('לא הבנתי לאיזו משימה לקשר את ההודעה.'); break; }
          const t2 = await db.getTask(taskId);
          outputs.push(await createMessageFor(user, {
            taskId, phone: a.to_phone || null, contactQuery: a.to_name || null,
            body: a.body, sendAt: a.send_at || t2?.due_at || null,
          }, deps));
          break;
        }
        case 'assign': {
          const { ids } = await T.resolveRefs(user, [a.ref]);
          if (!ids.length) break;
          const changed = await T.setAssignee(user, ids, assigneeId(user, deps, a.to));
          outputs.push(R.renderAssigned(changed, viewOpts(user, deps)));
          await notifyAssignment(user, changed.map((c) => c.task), deps);
          break;
        }
        case 'complete': {
          const r = await resolveOrAsk(user, a.ref, 'complete', {}, deps);
          if (r.ask) { outputs.push(r.ask); break; }
          if (r.ids.length) outputs.push(await applyVerb(user, 'complete', {}, r.ids, deps));
          break;
        }
        case 'note': {
          const r = await resolveOrAsk(user, a.ref, 'note', { text: a.text }, deps);
          if (r.ask) { outputs.push(r.ask); break; }
          if (r.ids.length) outputs.push(await addNoteTo(user, r.ids[0], a.text, deps));
          break;
        }
        case 'show_notes': {
          const r = await resolveOrAsk(user, a.ref, 'note_show', {}, deps);
          if (r.ask) { outputs.push(r.ask); break; }
          if (r.ids.length) outputs.push(await applyVerb(user, 'note_show', {}, r.ids, deps));
          break;
        }
        case 'snooze':
        case 'update': {
          const { ids } = await T.resolveRefs(user, [a.ref]);
          if (!ids.length) break;
          if (a.type === 'snooze' || (a.due && !a.title)) {
            const due = a.due ? new Date(a.due) : T.tomorrowMorning();
            const moved = await T.snoozeTasks(user, ids, due, a.all_day !== false);
            outputs.push(R.renderSnoozed(moved));
          } else {
            const fields = {};
            if (a.title) fields.title = a.title;
            if (a.due !== undefined) { fields.due_at = normDue(a.due); fields.all_day = a.all_day !== false; }
            if (a.shared !== undefined) fields.shared = !!a.shared;
            const t = await db.updateTask(ids[0], fields);
            if (t) outputs.push(`✏️ עודכן: *${t.title}*`);
          }
          break;
        }
        case 'delete': {
          const r = await resolveOrAsk(user, a.ref, 'delete', {}, deps);
          if (r.ask) { outputs.push(r.ask); break; }
          if (r.ids.length) outputs.push(await applyVerb(user, 'delete', {}, r.ids, deps));
          break;
        }
        case 'list': {
          const tasks = await db.openTasksFor(user);
          const doneTasks = a.filter === 'done' ? await db.recentlyDone(user) : null;
          const o = { ...viewOpts(user, deps), doneTasks, noteCounts: await db.noteCounts(tasks.map((t) => t.id)), messageCounts: await db.messageCounts(tasks.map((t) => t.id)) };
          const view = a.filter === 'digest' || !a.filter
            ? R.renderDigest(user, tasks, o)
            : R.renderList(user, tasks, a.filter, o);
          await db.setRefs(user.id, view.order);
          outputs.push(view.text);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.error('פעולה נכשלה:', a?.type, e.message || e);
    }
  }

  if (addResults.length) outputs.unshift(R.renderAdded(addResults, viewOpts(user, deps)));

  if (dupSpecs.length) {
    await db.setState(user.id, {
      pending: { kind: 'confirm_add', specs: dupSpecs.map((d) => d.spec), expires_at: Date.now() + PENDING_TTL_MS },
    });
    outputs.push(R.renderDuplicatePrompt(dupSpecs[0].existing, dupSpecs[0].spec));
  }

  if (!outputs.length) {
    return parsed.reply || 'לא הבנתי מה לעשות עם זה. נסה למשל: "לשלם ארנונה עד יום ראשון", או שלח "עזרה".';
  }
  if (parsed.reply) outputs.push(`_${parsed.reply}_`);
  return outputs.join('\n\n');
}

// ── עזר ─────────────────────────────────────────────────────────────
async function addOne(user, spec, deps) {
  const res = await T.addTask(user, spec);
  if (res.duplicate) {
    await db.setState(user.id, {
      pending: { kind: 'confirm_add', specs: [spec], expires_at: Date.now() + PENDING_TTL_MS },
    });
    return { pendingPrompt: R.renderDuplicatePrompt(res.duplicate, spec) };
  }
  if (res.task?.shared) await notifyShared(user, [res.task], 'add', deps);
  if (res.task?.assigned_to) await notifyAssignment(user, [res.task], deps);
  return res;
}

/**
 * מטפל בשאלה פתוחה. מחזיר טקסט תשובה, או null אם ההודעה לא קשורה
 * לשאלה (ואז השאלה נזנחת וההודעה ממשיכה במסלול הרגיל).
 */
async function handlePending(user, pending, text, cmd, deps) {
  const pick = /^\d+$/.test(text.trim()) ? parseInt(text.trim(), 10) : null;

  switch (pending.kind) {
    case 'confirm_add':
      if (cmd?.kind === 'yes') { await db.clearPending(user.id); return resolvePending(user, pending, deps); }
      if (cmd?.kind === 'no') { await db.clearPending(user.id); return 'בסדר, לא הוספתי.'; }
      return null;

    case 'disambiguate': {
      if (cmd?.kind === 'no') { await db.clearPending(user.id); return 'בסדר, ויתרתי.'; }
      if (!pick || pick < 1 || pick > (pending.ids || []).length) return null;
      await db.clearPending(user.id);
      return applyVerb(user, pending.verb, pending.payload || {}, [pending.ids[pick - 1]], deps);
    }

    // ── אישור הודעה יוצאת ──
    // 1=שלח 2=ערוך 3=בטל 4=דחה. כל תשובה אחרת אינה אישור.
    case 'approve_message': {
      if (cmd?.kind === 'no') { await db.clearPending(user.id); await OB.cancel(user, pending.message_id); return '🗑️ ההודעה בוטלה ולא נשלחה.'; }
      if (!pick || pick < 1 || pick > 4) return null;
      const msg = await db.getMessage(pending.message_id);
      if (!msg) { await db.clearPending(user.id); return 'לא מצאתי את ההודעה.'; }

      if (pick === 1) { await db.clearPending(user.id); return OB.approveAndSend(user, msg.id, deps); }
      if (pick === 3) { await db.clearPending(user.id); await OB.cancel(user, msg.id); return '🗑️ ההודעה בוטלה ולא נשלחה.'; }
      if (pick === 4) {
        await db.clearPending(user.id);
        await db.updateMessage(msg.id, { status: 'scheduled', send_at: new Date(Date.now() + 3600e3).toISOString(), asked_at: null });
        return '🕗 אחזור אליך עם ההודעה בעוד שעה.';
      }
      // 2 = עריכה: ממתינים לנוסח החדש
      await db.setState(user.id, {
        pending: { kind: 'edit_message', message_id: msg.id, expires_at: Date.now() + PENDING_TTL_MS },
      });
      return rtlLine(`✏️ מה לכתוב במקום?\n\nהנוסח הנוכחי:\n"${msg.body}"`);
    }

    case 'edit_message': {
      if (cmd?.kind === 'no') { await db.clearPending(user.id); return 'בסדר, השארתי את הנוסח הקודם.'; }
      if (!text.trim()) return null;
      await db.clearPending(user.id);
      const updated = await OB.edit(user, pending.message_id, text.trim());
      const task = updated ? await db.getTask(updated.task_id) : null;
      await db.setState(user.id, {
        pending: { kind: 'approve_message', message_id: pending.message_id, expires_at: Date.now() + 6 * 3600e3 },
      });
      await db.updateMessage(pending.message_id, { status: 'awaiting_approval', asked_at: new Date().toISOString() });
      return R.renderApprovalRequest({ ...updated, body: text.trim() }, task);
    }

    // ── בחירת נמען מרשימת אנשי הקשר ──
    case 'contact_choice': {
      if (cmd?.kind === 'no') { await db.clearPending(user.id); return 'בסדר, ויתרתי.'; }
      const list = pending.contacts || [];
      if (!pick || pick < 1 || pick > list.length) return null;
      await db.clearPending(user.id);
      const c = list[pick - 1];
      return createMessageFor(user, { ...pending.draft, phone: c.phone, name: c.name }, deps);
    }

    case 'reminder_actions': {
      if (!pick || pick < 1 || pick > 3) return null;
      await db.clearPending(user.id);
      if (pick === 1) return applyVerb(user, 'complete', {}, [pending.task_id], deps);
      const due = pick === 2 ? new Date(Date.now() + 60 * 60e3) : T.tomorrowMorning();
      return applyVerb(user, 'snooze', { due: due.toISOString(), all_day: pick === 3 }, [pending.task_id], deps);
    }

    default:
      return null;
  }
}

/**
 * מבצע פעולה על משימות שכבר זוהו. משותף למסלול ה-AI ולמסלול
 * שאלות ההבהרה, כדי ששניהם יתנהגו בדיוק אותו דבר.
 */
async function applyVerb(user, verb, payload, ids, deps) {
  if (!ids.length) return 'לא מצאתי את המשימה.';
  switch (verb) {
    case 'complete': {
      const { done, repeated, already } = await T.completeTasks(user, ids);
      await notifyShared(user, done, 'done', deps);
      await notifyAssigner(user, done, deps);
      return R.renderDone(done, repeated, { already, ...viewOpts(user, deps) });
    }
    case 'snooze': {
      const due = payload.due ? new Date(payload.due) : T.tomorrowMorning();
      const moved = await T.snoozeTasks(user, ids, due, payload.all_day !== false);
      await notifyShared(user, moved.map((m) => m.task), 'snooze', deps);
      return R.renderSnoozed(moved);
    }
    case 'delete': {
      const removed = await T.deleteTasks(user, ids);
      await notifyShared(user, removed, 'delete', deps);
      return R.renderDeleted(removed);
    }
    case 'assign': {
      const changed = await T.setAssignee(user, ids, assigneeId(user, deps, payload.to));
      await notifyAssignment(user, changed.map((c) => c.task), deps);
      return R.renderAssigned(changed, viewOpts(user, deps));
    }
    case 'note':
      return addNoteTo(user, ids[0], payload.text, deps);
    case 'note_show': {
      const task = await db.getTask(ids[0]);
      if (!task) return 'לא מצאתי את המשימה.';
      return R.renderNotes(task, await db.getNotes(task.id), viewOpts(user, deps));
    }
    default:
      return 'לא הבנתי מה לעשות.';
  }
}

// ── הודעות יוצאות: יצירה, כולל זיהוי נמען ───────────────────────────
/**
 * draft = { taskId, phone?, contactQuery?, name?, body, sendAt? }
 * אם נמסר שם ולא מספר — מחפש באנשי הקשר, ושואל אם יש כמה התאמות.
 */
async function createMessageFor(user, draft, deps) {
  let { phone, name } = draft;

  if (!phone && draft.contactQuery) {
    const matches = deps.findContacts ? await deps.findContacts(user, draft.contactQuery) : [];
    if (!matches.length) {
      return `לא מצאתי איש קשר בשם "${draft.contactQuery}". אפשר להכתיב לי את המספר ישירות.`;
    }
    if (matches.length > 1 && matches[1].score >= matches[0].score - 0.15) {
      await db.setState(user.id, {
        pending: { kind: 'contact_choice', contacts: matches, draft, expires_at: Date.now() + PENDING_TTL_MS },
      });
      return R.renderContactChoice(draft.contactQuery, matches);
    }
    phone = matches[0].phone;
    name = matches[0].name;
  }

  if (!phone) return 'למי לשלוח? אפשר שם מאנשי הקשר או מספר טלפון.';

  try {
    const msg = await OB.compose(user, {
      taskId: draft.taskId, phone, name, body: draft.body, sendAt: draft.sendAt || null,
    });
    return R.renderMessageAttached(msg);
  } catch (e) {
    return `לא הצלחתי להכין את ההודעה: ${e.message}`;
  }
}

// מאתר הודעה לפי מספר המשימה שהוצג ברשימה
async function messageOfTaskRef(user, ref) {
  const { ids } = await T.resolveRefs(user, [ref]);
  if (!ids.length) return { error: 'לא מצאתי את המשימה. שלח "רשימה" לרענון המספרים.' };
  const msgs = await db.messagesForTask(ids[0]);
  if (!msgs.length) return { error: 'אין הודעה מקושרת למשימה הזו.' };
  return { msg: msgs[0], taskId: ids[0] };
}

// הוספת הערה + דחיפה מיידית לצד השני אם המשימה משותפת
async function addNoteTo(user, taskId, body, deps) {
  const task = await db.getTask(taskId);
  if (!task) return 'לא מצאתי את המשימה.';
  if (!body || !body.trim()) return 'מה לרשום כהערה?';
  await db.addNote(task.id, user.id, body.trim());
  const notes = await db.getNotes(task.id);

  if (task.shared) {
    const other = deps.partnerOf(user);
    if (other) await deps.notify(other, R.renderNoteFromPartner(user.name, task, body.trim()));
  }
  return R.renderNoteAdded(task, { count: notes.length });
}

/**
 * מזהה משימה לפי הפניה. אם יש כמה מועמדות קרובות — שואל במקום לנחש.
 * מחזיר { ids } או { ask } (טקסט השאלה, אחרי ששמר את ההקשר).
 */
async function resolveOrAsk(user, ref, verb, payload, deps) {
  const { ids, missing, ambiguous } = await T.resolveRefs(user, [ref]);
  if (ambiguous?.length) {
    const a = ambiguous[0];
    await db.setState(user.id, {
      pending: {
        kind: 'disambiguate', verb, payload,
        query: a.query, ids: a.candidates.map((t) => t.id),
        expires_at: Date.now() + PENDING_TTL_MS,
      },
    });
    return { ask: R.renderDisambiguation(a.query, a.candidates) };
  }
  return { ids, missing };
}

async function resolvePending(user, pending, deps) {
  if (pending.kind !== 'confirm_add') return 'בסדר.';
  const partner = deps.partnerOf(user);
  const results = [];
  for (const spec of pending.specs || []) {
    const res = await T.addTask(user, spec, { force: true });
    if (res.task) {
      results.push(res);
      if (res.task.shared) await notifyShared(user, [res.task], 'add', deps);
      if (res.task.assigned_to) await notifyAssignment(user, [res.task], deps);
    }
  }
  return R.renderAdded(results, viewOpts(user, deps));
}

function validPending(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.expires_at && Date.now() > p.expires_at) return null;
  return p;
}

function normDue(due) {
  if (!due) return null;
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// מודיע לצד השני על שינוי ברשימה המשותפת
// הודעה לצד השני שהוטלה עליו משימה (פעם אחת בלבד לכל שיוך)
async function notifyAssignment(actor, tasks, deps) {
  const other = deps.partnerOf(actor);
  if (!other) return;
  for (const t of (tasks || [])) {
    if (!t?.assigned_to || t.assigned_to !== other.id) continue;
    if (t.assign_notified_at) continue;
    await deps.notify(other, R.renderAssignedToYou(actor.name, t));
    await db.updateTask(t.id, { assign_notified_at: new Date().toISOString() });
  }
}

// הודעה למי שהטיל את המשימה, כשהיא בוצעה ע"י הצד השני
async function notifyAssigner(actor, doneTasks, deps) {
  const other = deps.partnerOf(actor);
  if (!other) return;
  for (const t of (doneTasks || [])) {
    // רק כשמשימה הייתה משויכת למי שסימן, והמטיל הוא הצד השני
    if (t.assigned_to !== actor.id) continue;
    if (!t.created_by || t.created_by === actor.id) continue;
    await deps.notify(other, R.renderAssignedDone(actor.name, t));
  }
}

async function notifyShared(actor, tasks, kind, deps) {
  let shared = (tasks || []).filter((t) => t.shared);
  // משימה שהוטלה עליי ע"י הצד השני — notifyAssigner כבר שולח הודעה
  // עשירה יותר ("סיים את המשימה שהטלת"), אז לא מודיעים פעמיים.
  if (kind === 'done') {
    shared = shared.filter((t) => !(t.assigned_to === actor.id && t.created_by && t.created_by !== actor.id));
  }
  if (!shared.length) return;
  const other = deps.partnerOf(actor);
  if (!other) return;
  for (const t of shared) {
    const text = R.renderPartnerNotice(actor.name, t, kind);
    if (text) await deps.notify(other, text);
  }
}

/**
 * המשימות הפתוחות לפי אותו סדר שהוצג למשתמש לאחרונה.
 * חשוב: ה-LLM מקבל את הרשימה הזו ממוספרת, ולכן "בוצע 3" שהוא מחזיר
 * מצביע בדיוק על אותה משימה שהמשתמש רואה כ-3.
 */
async function orderedTasks(user) {
  const open = await db.openTasksFor(user);
  const byId = new Map(open.map((t) => [t.id, t]));
  const refs = await db.getRefs(user.id);

  const ordered = [];
  for (const r of refs) {
    const t = byId.get(r.task_id);
    if (t) { ordered.push(t); byId.delete(r.task_id); }
  }
  for (const t of byId.values()) ordered.push(t);      // משימות חדשות בסוף

  await db.setRefs(user.id, ordered.map((t) => t.id));
  return ordered;
}
