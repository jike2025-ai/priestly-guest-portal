'use strict';
const crypto = require('crypto');
const E = process.env;

// Single source of truth for prices (naira per night + caution fee). Keep in step with index.html.
const ROOMS = {
  'new-york':  { name: 'New York',       tier: 'VIP',       rate: 220000, caution: 50000 },
  'moscow':    { name: 'Moscow',         tier: 'VIP',       rate: 220000, caution: 50000 },
  'rio':       { name: 'Rio de Janeiro', tier: 'Executive', rate: 200000, caution: 50000 },
  'paris':     { name: 'Paris',          tier: 'Executive', rate: 200000, caution: 50000 },
  'dubai':     { name: 'Dubai',          tier: 'Standard',  rate: 180000, caution: 50000 },
  'giza':      { name: 'Giza',           tier: 'Standard',  rate: 180000, caution: 50000 },
  'santorini': { name: 'Santorini',      tier: 'Executive', rate: 100000, caution: 30000 },
  'abuja':     { name: 'Abuja',          tier: 'Executive', rate: 100000, caution: 30000 },
  'zanzibar':  { name: 'Zanzibar',       tier: 'Standard',  rate: 90000,  caution: 30000 },
  'kigali':    { name: 'Kigali',         tier: 'Standard',  rate: 90000,  caution: 30000 }
};
const SITE = (E.SITE_URL || 'https://jike2025-ai.github.io/priestly-guest-portal').replace(/\/$/, '');
const ORIGIN = E.ALLOWED_ORIGIN || 'https://jike2025-ai.github.io';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const json = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  return false;
}

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${E.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: E.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await r.json(); } catch (e) { /* empty body */ }
  return { status: r.status, ok: r.ok, data };
}
async function paystack(path, body) {
  const r = await fetch('https://api.paystack.co' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${E.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
  return { ok: !!(r.ok && j && j.status), data: j && j.data, message: j && j.message };
}
async function mail(to, subject, html) {
  if (!E.RESEND_API_KEY) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${E.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: E.FROM_EMAIL || 'Priestly Apartments <onboarding@resend.dev>', to: Array.isArray(to) ? to : [to], subject, html })
  });
  return r.ok;
}
const owners = () => (E.OWNER_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);

// ---------- dates & prices ----------
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z'));
const nightsBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
function quote(roomId, ci, co) {
  const room = ROOMS[roomId];
  if (!room) throw bad('Please choose an apartment');
  if (!isDate(ci) || !isDate(co)) throw bad('Please choose your check-in and check-out dates');
  if (ci < today()) throw bad('Check-in cannot be in the past');
  const nights = nightsBetween(ci, co);
  if (nights < 1) throw bad('Check-out must be after check-in');
  if (nights > 30) throw bad('For stays longer than 30 nights, please contact the front desk');
  const subtotal = nights * room.rate;
  return { room, nights, rate: room.rate, caution: room.caution, subtotal, total: subtotal + room.caution };
}

// ---------- emails ----------
const naira = n => '\u20A6' + Number(n).toLocaleString('en-NG');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fd = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fdt = s => new Date(s).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
function rows(b) {
  const r = ROOMS[b.room] || { name: b.room, tier: '' };
  return [
    ['Reference', b.reference],
    ['Apartment', r.name + (r.tier ? ' (' + r.tier + ')' : '')],
    ['Check-in', fd(b.check_in) + (E.CHECKIN_TIME ? ', from ' + E.CHECKIN_TIME : '')],
    ['Check-out', fd(b.check_out) + (E.CHECKOUT_TIME ? ', by ' + E.CHECKOUT_TIME : '')],
    ['Guests', b.guests],
    [`${b.nights} night${b.nights > 1 ? 's' : ''} x ${naira(b.rate)}`, naira(b.nights * b.rate)],
    ['Caution fee', naira(b.caution)]
  ];
}
function emailHtml(title, lead, b, extra) {
  const td = 'padding:8px 0;border-bottom:1px solid #eadfc8;';
  const rs = rows(b).concat(extra || []).map(r => `<tr><td style="${td}color:#6b6459">${esc(r[0])}</td><td style="${td}text-align:right">${esc(r[1])}</td></tr>`).join('');
  return `<div style="background:#f6f0e2;padding:24px;font-family:Arial,sans-serif;color:#1b1712"><div style="max-width:520px;margin:auto;background:#fff;border-top:5px solid #a11c24;padding:26px"><div style="font:italic 600 14px Georgia;color:#9c7a3c">Priestly Apartments &middot; Awka</div><h1 style="font:600 24px Georgia;margin:8px 0">${esc(title)}</h1><p style="margin:0 0 16px;color:#6b6459">${esc(lead)}</p><table style="width:100%;border-collapse:collapse;font-size:14px">${rs}<tr><td style="padding:12px 0;font-weight:bold">Total paid</td><td style="padding:12px 0;text-align:right;font:bold 20px Georgia;color:#6e1017">${naira(b.total)}</td></tr></table><p style="margin:22px 0 0;font-size:12px;color:#6b6459">Chief Ikechukwu Udenka Memorial Lane, close to Government House, Awka &middot; 0912 728 9246 &middot; 0913 844 6711</p></div></div>`;
}
async function sendReceipts(b) {
  const first = String(b.guest_name).split(' ')[0];
  const paid = [['Paid on', b.paid_at ? fdt(b.paid_at) : ''], ['Payment method', b.channel || '']];
  let guestOk = false;
  try { guestOk = await mail(b.guest_email, `Booking confirmed - receipt ${b.reference}`, emailHtml('Booking confirmed', `Hi ${first}, your payment was received and your stay is confirmed. Please keep this email as your receipt.`, b, paid)); } catch (e) { console.error('guest mail', e.message); }
  try {
    if (owners().length) await mail(owners(), `PAID: ${(ROOMS[b.room] || {}).name || b.room} ${b.check_in} to ${b.check_out} - ${b.guest_name}`,
      emailHtml('New paid booking', 'A guest has paid online.', b, [['Guest', b.guest_name], ['Phone', b.guest_phone], ['Email', b.guest_email]].concat(paid, [['Guest receipt email', guestOk ? 'sent' : 'FAILED - contact guest']])));
  } catch (e) { console.error('owner mail', e.message); }
}
async function alertOwner(subject, text) { try { if (owners().length) await mail(owners(), subject, `<p>${esc(text)}</p>`); } catch (e) { /* ignore */ } }

// ---------- confirm a payment (safe to call many times) ----------
async function confirmBooking(ref) {
  const q = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}&select=*`);
  const b = q.data && q.data[0];
  if (!b) return { status: 'not_found' };
  if (b.status === 'confirmed') return { status: 'confirmed', booking: b };
  if (!['pending', 'expired'].includes(b.status)) return { status: 'review', booking: b };
  // Never trust the browser: ask Paystack directly whether this reference was paid.
  const p = await paystack('/transaction/verify/' + encodeURIComponent(ref));
  const d = p.data;
  if (!d || d.status !== 'success') return { status: d ? d.status : 'unknown', booking: b };
  if (d.amount !== b.total * 100 || d.currency !== 'NGN') {
    await sb(`bookings?reference=eq.${encodeURIComponent(ref)}`, { method: 'PATCH', body: { status: 'amount_mismatch' } });
    await alertOwner(`CHECK PAYMENT ${ref}`, `Paystack amount (${d.amount / 100}) does not match the booking total (${b.total}). Please check this payment manually.`);
    return { status: 'review', booking: b };
  }
  // Atomic claim: only one caller can move pending -> confirmed, so receipts are sent once.
  const c = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}&status=in.(pending,expired)`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { status: 'confirmed', paid_at: new Date().toISOString(), paystack_id: d.id, channel: d.channel }
  });
  if (c.status === 409) { // dates were taken by someone else after this hold expired
    await sb(`bookings?reference=eq.${encodeURIComponent(ref)}`, { method: 'PATCH', body: { status: 'paid_conflict' } });
    await alertOwner(`PAID BUT DATES TAKEN ${ref}`, `${b.guest_name} (${b.guest_phone}) paid ${b.total} but the dates are no longer free. Please contact them and refund or rebook.`);
    return { status: 'review', booking: b };
  }
  if (c.data && c.data.length) { await sendReceipts(c.data[0]); return { status: 'confirmed', booking: c.data[0] }; }
  return { status: 'confirmed', booking: b };
}

module.exports = { ROOMS, SITE, E, bad, json, cors, sb, paystack, today, quote, confirmBooking, crypto };
