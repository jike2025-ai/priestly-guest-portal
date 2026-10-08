const { cors, json, sb, paystack, SITE, E, bad, quote, crypto } = require('../lib/core');

// POST /api/book -> saves a 15-minute hold, starts a Paystack payment, returns the payment link
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

    const q = quote(b.room, b.checkIn, b.checkOut); // price is always worked out here, never trusted from the browser
    const hold = parseInt(E.HOLD_MINUTES, 10) || 15;
    await sb(`bookings?status=eq.pending&hold_expires_at=lt.${new Date().toISOString()}`, { method: 'PATCH', body: { status: 'expired' } });

    const reference = 'PA-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const ins = await sb('bookings', {
      method: 'POST', prefer: 'return=minimal',
      body: { reference, room: b.room, check_in: b.checkIn, check_out: b.checkOut, nights: q.nights, guests, guest_name: name, guest_phone: phone, guest_email: email, rate: q.rate, caution: q.caution, total: q.total, status: 'pending', hold_expires_at: new Date(Date.now() + hold * 60000).toISOString() }
    });
    if (ins.status === 409) throw bad('Sorry, those dates were just taken. Please choose different dates.', 409);
    if (!ins.ok) throw Object.assign(new Error('insert failed'), { detail: 'SAVE step: Supabase said ' + ins.status + ' ' + JSON.stringify(ins.data).slice(0, 250) });

    const p = await paystack('/transaction/initialize', {
      email, amount: q.total * 100, currency: 'NGN', reference,
      callback_url: `${SITE}/book.html?ref=${reference}`,
      metadata: { room: q.room.name, check_in: b.checkIn, check_out: b.checkOut, guest: name, phone }
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
