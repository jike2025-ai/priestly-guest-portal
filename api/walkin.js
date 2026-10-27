const { cors, json, bad, sb, ROOMS, today, quote, crypto, alertOwner, fd, naira } = require('../lib/core');

// POST /api/walkin  (reception only, protected by STAFF_PIN)
//   {pin, action:'list'}
//   {pin, action:'overview'}                    (staff dashboard: all apartments + bookings)
//   {pin, action:'create', room, checkIn, checkOut, name, phone, guests, note, paid}
//   {pin, action:'cancel', reference}          (walk-in bookings only)
// A walk-in is saved in the SAME bookings table as online bookings, so the database's no_double_booking
// rule and the online calendar treat it exactly the same: those dates disappear from the website instantly.
const h = s => crypto.createHash('sha256').update(String(s)).digest();
const clean = (s, n) => String(s || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, n);

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const pin = process.env.STAFF_PIN;
    if (!pin) throw bad('Reception booking is not set up yet', 503);
    if (!crypto.timingSafeEqual(h(b.pin), h(pin))) { await new Promise(r => setTimeout(r, 900)); throw bad('Wrong staff PIN', 403); }

    if (b.action === 'list') {
      const now = new Date().toISOString();
      const r = await sb(`bookings?select=reference,room,check_in,check_out,nights,guest_name,guest_phone,total,status,channel&check_out=gte.${today()}&or=(status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${now}))&order=check_in&limit=200`);
      if (!r.ok) throw new Error('list failed');
      return json(res, 200, { bookings: r.data });
    }

    if (b.action === 'overview') {
      // everything the staff dashboard needs in one call: all apartments + bookings from 60 days ago onwards
      const now = new Date().toISOString();
      const from = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const r = await sb(`bookings?select=reference,room,check_in,check_out,nights,guests,guest_name,guest_phone,guest_email,rate,caution,total,status,channel,special_requests,created_at,paid_at,hold_expires_at&check_out=gte.${from}&or=(status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${now}))&order=check_in&limit=1000`);
      if (!r.ok) throw new Error('overview failed');
      return json(res, 200, { today: today(), rooms: Object.entries(ROOMS).map(([id, v]) => ({ id, ...v })), bookings: r.data });
    }

    if (b.action === 'create') {
      if (!ROOMS[b.room]) throw bad('Please choose an apartment');
      const name = clean(b.name, 80), phone = clean(b.phone, 20), note = clean(b.note, 200);
      if (name.length < 2) throw bad('Please enter the guest name');
      if (!/^\+?[0-9]{7,15}$/.test(phone.replace(/[\s-]/g, ''))) throw bad('Please enter a valid phone number');
      const guests = Math.min(10, Math.max(1, parseInt(b.guests, 10) || 1));
      const q = quote(b.room, b.checkIn, b.checkOut);
      await sb(`bookings?status=eq.pending&hold_expires_at=lt.${new Date().toISOString()}`, { method: 'PATCH', body: { status: 'expired' } });
      const reference = 'PA-W-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      const paid = ['cash', 'transfer', 'pos', 'unpaid'].includes(b.paid) ? b.paid : 'cash';
      const row = {
        reference, room: b.room, check_in: b.checkIn, check_out: b.checkOut, nights: q.nights, guests,
        guest_name: name, guest_phone: phone, guest_email: 'walk-in@priestlyapartments.com',
        rate: q.rate, caution: q.caution, total: q.total, status: 'confirmed', paid_at: new Date().toISOString(), channel: 'walk-in',
        special_requests: ('WALK-IN at reception. Payment: ' + paid + (note ? '. ' + note : '')).slice(0, 500)
      };
      const ins = await sb('bookings', { method: 'POST', prefer: 'return=minimal', body: row });
      if (ins.status === 409) throw bad('Those dates are already booked for this apartment (online or at reception). Please choose other dates.', 409);
      if (!ins.ok) { console.error('walkin insert', ins.status, JSON.stringify(ins.data).slice(0, 200)); throw new Error('insert failed'); }
      await alertOwner(`WALK-IN booked: ${ROOMS[b.room].name} ${b.checkIn} to ${b.checkOut}`, `${name} (${phone}) booked ${ROOMS[b.room].name} from ${fd(b.checkIn)} to ${fd(b.checkOut)} at reception. Payment: ${paid}. Reference ${reference}. Total ${naira(q.total)} incl. caution fee. These dates are now blocked on the website.`);
      return json(res, 200, { reference, total: q.total, nights: q.nights });
    }

    if (b.action === 'cancel') {
      const ref = clean(b.reference, 40);
      const r = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}&channel=eq.walk-in&status=eq.confirmed`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'cancelled' } });
      if (!r.ok || !r.data || !r.data.length) throw bad('That walk-in booking was not found (online bookings cannot be cancelled here)', 404);
      await alertOwner(`WALK-IN cancelled ${ref}`, `Walk-in booking ${ref} (${r.data[0].guest_name}, ${r.data[0].room}, ${r.data[0].check_in} to ${r.data[0].check_out}) was cancelled at reception. The dates are free again.`);
      return json(res, 200, { ok: true });
    }
    throw bad('Unknown action');
  } catch (e) {
    if (!e.status) console.error('walkin', e.message);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
};
