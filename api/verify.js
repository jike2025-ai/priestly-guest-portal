const { cors, json, confirmBooking, ROOMS } = require('../lib/core');

// GET /api/verify?ref=PA-XXXX  -> used by book.html after the guest returns from Paystack
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  const ref = String(req.query.ref || '');
  if (!/^PA-[A-F0-9]{16}$/.test(ref)) return json(res, 400, { error: 'Invalid reference' });
  try {
    const r = await confirmBooking(ref);
    const b = r.booking;
    const room = b && (ROOMS[b.room] || { name: b.room, tier: '' });
    json(res, 200, { status: r.status, booking: b && { reference: b.reference, room: room.name, tier: room.tier, checkIn: b.check_in, checkOut: b.check_out, nights: b.nights, guests: b.guests, rate: b.rate, caution: b.caution, total: b.total, name: b.guest_name, paidAt: b.paid_at, channel: b.channel } });
  } catch (e) { console.error('verify', e.message); json(res, 500, { error: 'Could not check the payment' }); }
};
