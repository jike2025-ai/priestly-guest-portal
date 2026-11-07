'use strict';
// Minimal Tuya / Smart Life cloud client: runs the "arrival scene" (curtains, AC, lights) once per stay.
// Env: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_BASE (default https://openapi.tuyaeu.com), TUYA_ARRIVAL (JSON, see below)
// TUYA_ARRIVAL = { "new-york": [ { "path": "/v1.0/devices/DEVICE_ID/commands", "body": { "commands": [ { "code": "control", "value": "open" } ] } }, ... ] }
const crypto = require('crypto');
const E = process.env;
const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');  // pasted values often carry spaces, newlines or quotes
const ID = () => clean(E.TUYA_ACCESS_ID), SECRET = () => clean(E.TUYA_ACCESS_SECRET);
const BASE = () => (clean(E.TUYA_BASE) || 'https://openapi.tuyaeu.com').replace(/\/$/, '');
const EMPTY = crypto.createHash('sha256').update('').digest('hex');
let tok = { v: '', exp: 0 };

const sign = (str) => crypto.createHmac('sha256', SECRET()).update(str).digest('hex').toUpperCase();
async function call(method, path, body, withToken) {
  const t = String(Date.now()), data = body ? JSON.stringify(body) : '';
  const hash = data ? crypto.createHash('sha256').update(data).digest('hex') : EMPTY;
  const str = ID() + (withToken ? tok.v : '') + t + [method, hash, '', path].join('\n');
  const r = await fetch(BASE() + path, { method, body: data || undefined, headers: { client_id: ID(), sign: sign(str), t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json', ...(withToken ? { access_token: tok.v } : {}) } });
  let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
  return j || {};
}
async function token() {
  if (tok.v && Date.now() < tok.exp - 60000) return;
  const j = await call('GET', '/v1.0/token?grant_type=1', null, false);
  if (!j.success) throw new Error('tuya token: ' + (j.msg || 'failed'));
  tok = { v: j.result.access_token, exp: Date.now() + (j.result.expire_time || 7000) * 1000 };
}
// Run every step for a room. Never throws: a failed curtain must never break the greeting.
async function arrival(room) {
  try {
    if (!ID() || !SECRET() || !E.TUYA_ARRIVAL) return [];
    const steps = (JSON.parse(E.TUYA_ARRIVAL)[room]) || [];
    if (!steps.length) return [];
    await token();
    const out = await Promise.all(steps.map(async s => {
      const j = await call(s.method || 'POST', s.path, s.body, true);
      if (!j.success) console.error('tuya step failed', room, s.path, j.code, j.msg);
      return !!j.success;
    }));
    return out;
  } catch (e) { console.error('tuya', e.message); return []; }
}
// Raw call for the owner's diagnostics (behind ALEXA_KEY): list devices, read control codes, send one test command.
async function raw(method, path, body) { await token(); return call(method, path, body, true); }
// Step-by-step health check (no secrets shown): which Tuya call works, which is rejected.
async function check() {
  const r = { idLength: ID().length, secretLength: SECRET().length, base: BASE() };
  const t = await call('GET', '/v1.0/token?grant_type=1', null, false);
  r.token = { ok: !!t.success, code: t.code, msg: t.msg };
  if (!t.success) return r;
  tok = { v: t.result.access_token, exp: Date.now() + (t.result.expire_time || 7000) * 1000 };
  for (const [k, path] of [['associatedUsers', '/v1.0/iot-01/associated-users/devices'], ['associatedUsersSize', '/v1.0/iot-01/associated-users/devices?size=20'], ['projectDevices', '/v1.3/iot-03/devices?page_size=20']]) {
    const j = await call('GET', path, null, true);
    r[k] = { ok: !!j.success, code: j.code, msg: j.msg, count: j.result && (j.result.devices || j.result.list || []).length };
  }
  return r;
}
module.exports = { arrival, raw, check, _sign: sign };
