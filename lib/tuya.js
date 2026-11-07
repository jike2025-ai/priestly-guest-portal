'use strict';
// Minimal Tuya / Smart Life cloud client: runs the "arrival scene" (curtains, AC, lights) once per stay.
// Env: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_BASE (default https://openapi.tuyaeu.com), TUYA_ARRIVAL (JSON, see below)
// TUYA_ARRIVAL = { "new-york": [ { "path": "/v1.0/devices/DEVICE_ID/commands", "body": { "commands": [ { "code": "control", "value": "open" } ] } }, ... ] }
const crypto = require('crypto');
const E = process.env;
const BASE = () => (E.TUYA_BASE || 'https://openapi.tuyaeu.com').replace(/\/$/, '');
const EMPTY = crypto.createHash('sha256').update('').digest('hex');
let tok = { v: '', exp: 0 };

const sign = (str) => crypto.createHmac('sha256', E.TUYA_ACCESS_SECRET).update(str).digest('hex').toUpperCase();
async function call(method, path, body, withToken) {
  const t = String(Date.now()), data = body ? JSON.stringify(body) : '';
  const hash = data ? crypto.createHash('sha256').update(data).digest('hex') : EMPTY;
  const str = E.TUYA_ACCESS_ID + (withToken ? tok.v : '') + t + [method, hash, '', path].join('\n');
  const r = await fetch(BASE() + path, { method, body: data || undefined, headers: { client_id: E.TUYA_ACCESS_ID, sign: sign(str), t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json', ...(withToken ? { access_token: tok.v } : {}) } });
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
    if (!E.TUYA_ACCESS_ID || !E.TUYA_ACCESS_SECRET || !E.TUYA_ARRIVAL) return [];
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
module.exports = { arrival, raw, _sign: sign };
