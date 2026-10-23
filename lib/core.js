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
  'santorini': { name: 'Santorini',      tier: 'Self-con VIP',      rate: 100000, caution: 30000 },
  'abuja':     { name: 'Abuja',          tier: 'Self-con VIP',      rate: 100000, caution: 30000 },
  'zanzibar':  { name: 'Zanzibar',       tier: 'Self-con Standard', rate: 90000,  caution: 30000 },
  'kigali':    { name: 'Kigali',         tier: 'Self-con VIP',      rate: 90000,  caution: 30000 }
};
const SITE = (E.SITE_URL || 'https://www.priestlyapartments.com').replace(/\/$/, '');
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
  // Guests who reply to a receipt reach the owners (REPLY_TO, or the first OWNER_EMAILS address).
  const replyTo = E.REPLY_TO || office()[0] || owners()[0];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${E.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: E.FROM_EMAIL || 'Priestly Apartments <onboarding@resend.dev>', to: Array.isArray(to) ? to : [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) })
  });
  if (!r.ok) { let t = ''; try { t = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ } console.error('resend refused', r.status, t); }
  return r.ok;
}
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const owners = () => list(E.OWNER_EMAILS);   // the owner's private email(s)
const office = () => list(E.OFFICE_EMAILS);  // reception / office email(s)

// ---------- special requests (booking form) ----------
const SR_OPTIONS = ['Airport pickup', 'Early check-in', 'Late check-out', 'Extra bedding / baby cot', 'Celebration setup (birthday, anniversary)', 'Meal or groceries ready on arrival'];
function buildRequests(b) {
  const clean = x => String(x || '').replace(/\s+/g, ' ').trim();
  const picked = [...new Set((Array.isArray(b.requests) ? b.requests : []).map(String).filter(x => SR_OPTIONS.includes(x)))];
  const pickup = clean(b.pickup).slice(0, 120), note = clean(b.note).slice(0, 500);
  const parts = picked.map(x => (x === 'Airport pickup' && pickup ? `Airport pickup (${pickup})` : x));
  if (note) parts.push('Note: ' + note);
  return parts.join('; ');
}

// ---------- guest registration details (booking form) ----------
const CHILD_OPTIONS = ['Toddler (under 3)', 'Children (3 to 17)', 'Toddler and older children'];
function buildGuestInfo(b) {
  const clean = x => String(x || '').replace(/\s+/g, ' ').trim();
  const gender = ['Male', 'Female'].includes(b.gender) ? b.gender : '';
  const nin = String(b.nin || '').replace(/\s/g, '');
  const address = clean(b.address).slice(0, 200);
  if (!gender) throw bad('Please select your sex');
  if (!/^[0-9]{11}$/.test(nin)) throw bad('Please enter your 11-digit NIN');
  if (address.length < 8) throw bad('Please enter your home address');
  const kids = CHILD_OPTIONS.includes(b.children) ? b.children : '';
  const kidsNote = kids ? clean(b.childrenNote).slice(0, 80) : '';
  return { gender, nin, home_address: address, children: kids ? (kids + (kidsNote ? ' - ' + kidsNote : '')) : null };
}
const maskNin = n => n ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + String(n).slice(-4) : '';

// ---------- smart-lock passcodes (server only: DOOR_CODES = JSON of room id to code) ----------
function doorCodeFor(room) { try { const c = JSON.parse(E.DOOR_CODES || '{}')[room]; return c ? String(c) : ''; } catch (e) { return ''; } }
// A guest sees the passcode only for a paid booking, from check-in day until 12:00 noon on check-out day (Lagos time).
function doorCodeForBooking(b) {
  if (!b || b.status !== 'confirmed') return '';
  const now = new Date(), day = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const hour = parseInt(now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }), 10);
  if (day < b.check_in || day > b.check_out || (day === b.check_out && hour >= 12)) return '';
  return doorCodeFor(b.room);
}

// ---------- dates & prices (per night; every night ends at 12:00 noon the next day) ----------
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

// ---------- secure owner links (refund review) ----------
const sign = ref => { if (!E.ADMIN_SECRET) throw new Error('ADMIN_SECRET is not set'); return crypto.createHmac('sha256', E.ADMIN_SECRET).update(ref).digest('hex'); };
const checkSig = (ref, sig) => { try { const a = Buffer.from(sign(ref)), b = Buffer.from(String(sig || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); } catch (e) { return false; } };
const adminLink = ref => `${SITE}/admin.html?ref=${ref}&sig=${sign(ref)}`;

// ---------- branded emails ----------
const naira = n => '\u20A6' + Number(n).toLocaleString('en-NG');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/\x22/g, '&quot;');
const fd = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fdt = s => new Date(s).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
const roomLabel = b => { const r = ROOMS[b.room] || { name: b.room, tier: '' }; return r.name + (r.tier ? ' (' + r.tier + ')' : ''); };
function rows(b) {
  return [
    ['Reference', b.reference],
    ['Apartment', roomLabel(b)],
    ['Check-in', fd(b.check_in) + ' (any time on arrival)'],
    ['Check-out', 'By 12:00 noon, ' + fd(b.check_out)],
    ['Guests', b.guests],
    [`${b.nights} night${b.nights > 1 ? 's' : ''} x ${naira(b.rate)}`, naira(b.nights * b.rate)],
    ['Caution fee (refundable)', naira(b.caution)]
  ].concat(b.special_requests ? [['Special requests', b.special_requests]] : []);
}
function emailHtml({ title, lead, rows: rs = [], total, cta, note }) {
  const td = 'padding:9px 0;border-bottom:1px solid #eadfc8;';
  const body = rs.map(r => `<tr><td style='${td}color:#6b6459'>${esc(r[0])}</td><td style='${td}text-align:right'>${esc(r[1])}</td></tr>`).join('');
  const tot = total ? `<tr><td style='padding:14px 0;font-weight:bold'>${esc(total[0])}</td><td style='padding:14px 0;text-align:right;font:bold 22px Georgia,serif;color:#6e1017'>${esc(total[1])}</td></tr>` : '';
  const btn = cta ? `<p style='margin:22px 0 4px'><a href='${esc(cta.href)}' style='display:inline-block;background:#a11c24;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:6px'>${esc(cta.label)}</a></p>` : '';
  return `<div style='background:#f6f0e2;padding:20px 10px;font-family:Arial,sans-serif;color:#1b1712'><div style='max-width:560px;margin:auto'>`
    + `<div style='background:#1b1712;border-top:5px solid #a11c24;padding:18px 24px'><table role='presentation' style='border-collapse:collapse'><tr><td style='padding-right:12px'><img src='${SITE}/images/img-01.png' alt='' height='46' style='display:block;height:46px'></td><td><div style='font:600 20px Georgia,serif;color:#ffffff'>Priestly Apartments</div><div style='font:italic 13px Georgia,serif;color:#d9be86'>&hellip;come home to happiness.</div></td></tr></table></div>`
    + `<div style='background:#ffffff;padding:26px 24px'><h1 style='font:600 24px Georgia,serif;margin:0 0 8px'>${esc(title)}</h1><p style='margin:0 0 16px;color:#6b6459;line-height:1.5'>${esc(lead)}</p>`
    + `<table style='width:100%;border-collapse:collapse;font-size:14px'>${body}${tot}</table>${note ? `<p style='margin:16px 0 0;font-size:13px;color:#6b6459;line-height:1.5'>${esc(note)}</p>` : ''}${btn}`
    + `<p style='margin:24px 0 0;line-height:1.5'>Warm regards,<br><b>The Priestly Apartments Team</b></p></div>`
    + `<div style='background:#1b1712;color:#cfc7b5;padding:16px 24px;font-size:12px;line-height:1.7;text-align:center'>Chief Ikechukwu Udenka Memorial Lane, close to Government House, Awka<br>0912 728 9246 &middot; 0913 844 6711<br>Instagram @priestlyapartmentawka &middot; TikTok @priestly_homes_apartment &middot; Facebook: Priestly Homes</div></div></div>`;
}
async function sendReceipts(b) {
  const first = String(b.guest_name).split(' ')[0];
  const paid = [['Paid on', b.paid_at ? fdt(b.paid_at) : ''], ['Payment method', b.channel || '']];
  let guestOk = false;
  try {
    guestOk = await mail(b.guest_email, `Booking confirmed - receipt ${b.reference}`, emailHtml({
      title: 'Booking confirmed', lead: `Hi ${first}, your payment was received and your stay is confirmed. Please keep this email as your receipt.`,
      rows: rows(b).concat(paid), total: ['Total paid', naira(b.total)],
      note: `Your caution fee of ${naira(b.caution)} is refundable. After you check out, our team inspects the apartment; you can then request the refund from your receipt page.` + (b.special_requests ? ' We have noted your special requests. Our front desk will contact you to confirm them and any extra cost.' : '') + ' Your apartment door passcode will appear on your receipt page from your check-in day. Type it on the keypad, then press # to unlock.',
      cta: { label: 'View receipt / request caution refund', href: `${SITE}/book.html?ref=${b.reference}` }
    }));
  } catch (e) { console.error('guest mail', e.message); }
  const detail = rows(b).concat([['Guest', b.guest_name], ['Phone', b.guest_phone], ['Email', b.guest_email]],
    b.gender ? [['Sex', b.gender]] : [], b.home_address ? [['Home address', b.home_address]] : [], b.nin ? [['NIN (last 4 digits shown, full number is in Supabase)', maskNin(b.nin)]] : [],
    b.children ? [['Travelling with children', b.children]] : [], paid);
  // Reception copy goes out as its own email so the office and owner addresses are never shown to each other.
  try {
    if (office().length) await mail(office(), `RECEPTION - payment confirmed: ${roomLabel(b)} ${b.check_in} to ${b.check_out} - ${b.guest_name}` + (b.special_requests ? ' [SPECIAL REQUESTS]' : ''), emailHtml({
      title: 'Payment confirmed', lead: 'Reception: this booking has been paid online and the dates are now blocked. Please prepare the apartment for arrival.' + (b.special_requests ? ' The guest made special requests (listed below). Please call them to confirm and agree any extra cost.' : ''),
      rows: detail.concat([['Guest receipt email', guestOk ? 'sent' : 'FAILED - contact guest']]),
      total: ['Total paid', naira(b.total)]
    }));
  } catch (e) { console.error('office mail', e.message); }
  try {
    if (owners().length) await mail(owners(), `PAID: ${roomLabel(b)} ${b.check_in} to ${b.check_out} - ${b.guest_name}` + (b.special_requests ? ' [SPECIAL REQUESTS]' : ''), emailHtml({
      title: 'New paid booking', lead: 'A guest has paid online.' + (b.special_requests ? ' They made special requests (listed below). Please contact them to confirm.' : ''),
      rows: detail.concat([['Guest receipt email', guestOk ? 'sent' : 'FAILED - contact guest']]),
      total: ['Total paid', naira(b.total)]
    }));
  } catch (e) { console.error('owner mail', e.message); }
}
async function alertOwner(subject, text) { try { const to = owners().concat(office()); if (to.length) await mail(to, subject, `<p>${esc(text)}</p>`); } catch (e) { /* ignore */ } }

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
  if (c.data && c.data.length) {
    const row = c.data[0];
    // The requests also travel in Paystack's metadata, so they still reach the emails if the database column has not been added yet.
    if (!row.special_requests && d.metadata && d.metadata.special_requests) row.special_requests = String(d.metadata.special_requests).slice(0, 800);
    await sendReceipts(row);
    return { status: 'confirmed', booking: row };
  }
  return { status: 'confirmed', booking: b };
}

module.exports = { SR_OPTIONS, buildRequests, buildGuestInfo, doorCodeFor, doorCodeForBooking, GUEST_COLS: ['gender', 'nin', 'home_address', 'children'], ROOMS, SITE, E, bad, json, cors, sb, paystack, mail, owners, office, today, quote, confirmBooking, crypto, sign, checkSig, adminLink, naira, esc, fd, fdt, roomLabel, emailHtml };
