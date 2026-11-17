const { cors, json, sb, paystack, SITE, E, bad, quote, crypto, buildRequests, buildGuestInfo, GUEST_COLS } = require('../lib/core');

// POST /api/book -> saves a 15-minute hold, starts a Paystack payment, returns the payment link
// Repeated attempts are limited: at most 5 per phone number or email, and 8 per visitor address, in any 15 minutes.
const WINDOW_MIN = 15, MAX_PER_GUEST = 5, MAX_PER_IP = 8;
const ipHits = new Map(); // best effort per server instance; the per-guest check below uses the database and holds across instances
function tooMany(ip) {
  const now = Date.now(), list = (ipHits.get(ip) || []).filter(t => now - t < WINDOW_MIN * 60000);
  list.push(now); ipHits.set(ip, list);
  if (ipHits.size > 2000) for (const [k, v] of ipHits) if (!v.some(t => now - t < WINDOW_MIN * 60000)) ipHits.delete(k);
  return list.length > MAX_PER_IP;
}
const WAIT_MSG = 'Too many booking attempts. Please wait about 15 minutes and try again, or call the front desk to book.';
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.website) throw bad('Invalid request'); // hidden spam-trap field
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const phone = String(b.phone || '').replace(/[\s-]/g, '');
    const guests = parseInt(b.guests, 10) || 1;
    if (name.length < 2 || name.length > 80) throw bad('Please enter your full name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Please enter a valid email address');
    if (!/^\+?[0-9]{10,15}$/.test(phone)) throw bad('Please enter a valid phone number');
    if (guests < 1 || guests > 10) throw bad('Guests must be between 1 and 10');

    const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '').split(',')[0].trim() || 'unknown';
    if (tooMany(ip)) throw bad(WAIT_MSG, 429);
    const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
    const recent = await sb(`bookings?select=id&created_at=gt.${since}&or=(guest_phone.eq.${encodeURIComponent(phone)},guest_email.eq.${encodeURIComponent(email)})&channel=is.null&limit=${MAX_PER_GUEST + 1}`);
    if (recent.ok && Array.isArray(recent.data) && recent.data.length >= MAX_PER_GUEST) throw bad(WAIT_MSG, 429);

    const info = buildGuestInfo(b); // sex, NIN, address and children: validated here, never trusted from the browser
    const special = buildRequests(b); // only known options and trimmed text are kept
    const q = quote(b.room, b.checkIn, b.checkOut, 'online', String(b.option || '')); // price is always worked out here, never trusted from the browser
    const hold = parseInt(E.HOLD_MINUTES, 10) || 15;
    await sb(`bookings?status=eq.pending&hold_expires_at=lt.${new Date().toISOString()}`, { method: 'PATCH', body: { status: 'expired' } });

    const reference = 'PA-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const row = { reference, room: b.room, check_in: b.checkIn, check_out: b.checkOut, nights: q.nights, guests, guest_name: name, guest_phone: phone, guest_email: email, rate: q.rate, caution: q.caution, total: q.total, status: 'pending', hold_expires_at: new Date(Date.now() + hold * 60000).toISOString() };
    Object.assign(row, info);
    const spec2 = ((q.option ? 'ROOM OPTION: ' + q.option.label + '. ' : '') + (special || '')).slice(0, 500);
    if (spec2) row.special_requests = spec2;
    let ins = await sb('bookings', { method: 'POST', prefer: 'return=minimal', body: row });
    // If the special_requests column has not been added to Supabase yet, save the booking without it (the requests still travel in the Paystack metadata).
    if (spec2 && ins.status === 400 && /special_requests/i.test(JSON.stringify(ins.data))) { delete row.special_requests; ins = await sb('bookings', { method: 'POST', prefer: 'return=minimal', body: row }); }
    // If the new guest-detail columns are not in Supabase yet, do not block the guest: save without them and shout in the logs.
    if (ins.status === 400 && GUEST_COLS.some(c => new RegExp(c, 'i').test(JSON.stringify(ins.data)))) { GUEST_COLS.forEach(c => delete row[c]); console.error('MIGRATION MISSING: run supabase/migration-guest-details.sql, guest registration details were NOT saved for ' + reference); ins = await sb('bookings', { method: 'POST', prefer: 'return=minimal', body: row }); }
    if (ins.status === 409) throw bad('Sorry, those dates were just taken. Please choose different dates.', 409);
    if (!ins.ok) throw Object.assign(new Error('insert failed'), { detail: 'SAVE step: Supabase said ' + ins.status + ' ' + JSON.stringify(ins.data).slice(0, 250) });

    const p = await paystack('/transaction/initialize', {
      email, amount: q.total * 100, currency: 'NGN', reference,
      callback_url: `${SITE}/book.html?ref=${reference}`,
      metadata: { room: q.room.name, check_in: b.checkIn, check_out: b.checkOut, guest: name, phone, ...(special ? { special_requests: special } : {}) }
    });
    if (!p.ok || !p.data) {
      await sb(`bookings?reference=eq.${reference}`, { method: 'PATCH', body: { status: 'failed' } });
      throw Object.assign(new Error('paystack init failed'), { detail: 'PAY step: Paystack said "' + (p.message || 'no reply') + '"' });
    }
    json(res, 200, { reference, authorization_url: p.data.authorization_url, total: q.total });
  } catch (e) {
    console.error('book', e.message, e.detail || '');
    // In test mode only (test Paystack key), show what failed so it can be fixed. Never shown with a live key.
    const testMode = String(E.PAYSTACK_SECRET_KEY || '').startsWith('sk_test_');
    const extra = !e.status && testMode ? ' [Test mode detail: ' + (e.detail || e.message) + ']' : '';
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong. Please try again or contact the front desk.' + extra });
  }
};
