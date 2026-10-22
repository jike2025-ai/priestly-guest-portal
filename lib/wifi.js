// Shared helpers for the Wi-Fi voucher endpoints (CommonJS, Node 18+, no packages).

const crypto = require('crypto');

// ---- Supabase REST (server side only, uses the service key) ----
function supaHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  const h = { apikey: key, 'Content-Type': 'application/json' };
  // Legacy JWT keys also go in Authorization. New sb_secret_ keys must not.
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  return Object.assign(h, extra || {});
}

async function supa(path, opts) {
  const o = opts || {};
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Server is not configured (Supabase keys missing)');
  const r = await fetch(base + '/rest/v1/' + path, {
    method: o.method || 'GET',
    headers: supaHeaders(o.headers),
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) {
    const err = new Error((data && (data.message || data.error)) || ('Database error ' + r.status));
    err.status = r.status;
    throw err;
  }
  return { data, headers: r.headers };
}

// ---- Safe secret comparison ----
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const y = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---- CORS + no caching ----
function cors(req, res) {
  const origin = process.env.ALLOWED_ORIGIN;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  res.setHeader('Cache-Control', 'no-store');
}

function readBody(req) {
  const b = req.body;
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch (e) { return {}; } }
  return b || {};
}

// ---- Dates (Lagos is UTC+1 all year, no daylight saving) ----
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Voucher stops working on check-out day at WIFI_EXPIRE_HOUR (default 12:00 noon, Lagos time).
function expiryFor(checkOut) {
  const hour = Number(process.env.WIFI_EXPIRE_HOUR || 12);
  const [y, m, d] = checkOut.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 1, 0, 0));
}

module.exports = { supa, safeEqual, cors, readBody, validDate, daysBetween, expiryFor };
