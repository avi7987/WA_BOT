// =====================================================================
//  fake-db.js — Supabase מזויף בזיכרון, לבדיקות בלבד.
//  מחקה את החלק מ-postgrest שבו הקוד באמת משתמש.
// =====================================================================
import { randomUUID } from 'crypto';

const DEFAULTS = {
  pa_users: () => ({ id: randomUUID(), role: 'member', digest_time: '08:00', evening_digest: false, default_shared: false, sees_own_tasks: true, active: true, created_at: new Date().toISOString() }),
  pa_tasks: () => ({ id: randomUUID(), status: 'open', all_day: true, shared: false, notes: null, due_at: null, recurrence: null, remind_sent_at: null, done_at: null, done_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  pa_refs: () => ({ created_at: new Date().toISOString() }),
  pa_state: () => ({ pending: null, last_action: null, updated_at: new Date().toISOString() }),
  pa_log: () => ({ id: Math.random(), day: new Date().toISOString().slice(0, 10), sent_at: new Date().toISOString() }),
  pa_settings: () => ({}),
};

const UNIQUE = {
  pa_users: ['session_key'],
  pa_refs: ['user_id', 'n'],
  pa_state: ['user_id'],
  pa_log: ['user_id', 'kind', 'day'],
  pa_settings: ['key'],
};

export function createFakeSupabase() {
  const store = new Map();
  const rows = (t) => { if (!store.has(t)) store.set(t, []); return store.get(t); };
  return {
    from: (table) => new Q(rows, table),
    _dump: (table) => structuredClone(rows(table)),
  };
}

class Q {
  constructor(rows, table) {
    this.rows = rows; this.table = table;
    this.op = null; this.filters = []; this.ors = null;
    this.payload = null; this.orderBy = null; this.limitN = null;
    this.returning = false; this.mode = null; this.onConflict = null;
  }

  select() { if (this.op === null) this.op = 'select'; else this.returning = true; return this; }
  insert(v) { this.op = 'insert'; this.payload = v; return this; }
  upsert(v, o) { this.op = 'upsert'; this.payload = v; this.onConflict = o?.onConflict; return this; }
  update(v) { this.op = 'update'; this.payload = v; return this; }
  delete() { this.op = 'delete'; return this; }

  eq(c, v) { this.filters.push(['eq', c, v]); return this; }
  gte(c, v) { this.filters.push(['gte', c, v]); return this; }
  lte(c, v) { this.filters.push(['lte', c, v]); return this; }
  is(c, v) { this.filters.push(['is', c, v]); return this; }
  in(c, v) { this.filters.push(['in', c, v]); return this; }
  or(s) { this.ors = s.split(',').map((p) => p.split('.')); return this; }
  order(c, o) { this.orderBy = [c, o || {}]; return this; }
  limit(n) { this.limitN = n; return this; }

  maybeSingle() { this.mode = 'maybe'; return this._run(); }
  single() { this.mode = 'one'; return this._run(); }
  then(res, rej) { return this._run().then(res, rej); }

  _match(row) {
    for (const [op, c, v] of this.filters) {
      const cur = row[c];
      if (op === 'eq' && cur !== v) return false;
      if (op === 'gte' && !(cur >= v)) return false;
      if (op === 'lte' && !(cur !== null && cur !== undefined && cur <= v)) return false;
      if (op === 'is' && !(v === null ? cur === null || cur === undefined : cur === v)) return false;
      if (op === 'in' && !v.includes(cur)) return false;
    }
    if (this.ors) {
      const hit = this.ors.some(([col, o, val]) => {
        const cur = row[col];
        if (o !== 'eq') return false;
        if (val === 'true') return cur === true;
        if (val === 'false') return cur === false;
        return String(cur) === val;
      });
      if (!hit) return false;
    }
    return true;
  }

  async _run() {
    const data = this.rows(this.table);
    const def = DEFAULTS[this.table] || (() => ({}));
    const uniq = UNIQUE[this.table];
    const keyOf = (r) => (uniq ? uniq.map((k) => r[k]).join('|') : null);
    let out = [];

    switch (this.op) {
      case 'insert': {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const it of items) {
          if (uniq && data.some((r) => keyOf(r) === keyOf({ ...def(), ...it }))) {
            return { data: null, error: { message: 'duplicate key' } };
          }
          const row = { ...def(), ...it };
          data.push(row);
          out.push(row);
        }
        break;
      }
      case 'upsert': {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const it of items) {
          const merged = { ...def(), ...it };
          const idx = uniq ? data.findIndex((r) => keyOf(r) === keyOf(merged)) : -1;
          if (idx >= 0) {
            data[idx] = { ...data[idx], ...it };
            out.push(data[idx]);
          } else {
            data.push(merged);
            out.push(merged);
          }
        }
        break;
      }
      case 'update': {
        for (const row of data) {
          if (!this._match(row)) continue;
          Object.assign(row, this.payload, { updated_at: new Date().toISOString() });
          out.push(row);
        }
        break;
      }
      case 'delete': {
        for (let i = data.length - 1; i >= 0; i--) {
          if (this._match(data[i])) out.push(...data.splice(i, 1));
        }
        break;
      }
      default: {
        out = data.filter((r) => this._match(r));
        if (this.orderBy) {
          const [c, o] = this.orderBy;
          const asc = o.ascending !== false;
          const nullsFirst = o.nullsFirst === true;
          out = [...out].sort((a, b) => {
            const av = a[c], bv = b[c];
            if (av == null && bv == null) return 0;
            if (av == null) return nullsFirst ? -1 : 1;
            if (bv == null) return nullsFirst ? 1 : -1;
            return (av < bv ? -1 : av > bv ? 1 : 0) * (asc ? 1 : -1);
          });
        }
        if (this.limitN) out = out.slice(0, this.limitN);
      }
    }

    const clone = structuredClone(out);
    if (this.mode === 'one') {
      return clone.length ? { data: clone[0], error: null } : { data: null, error: { message: 'no rows' } };
    }
    if (this.mode === 'maybe') return { data: clone[0] || null, error: null };
    return { data: clone, error: null };
  }
}
