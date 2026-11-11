const { cors, json, sb, ROOMS, today, checkSig } = require('../lib/core');
const ical = require('../lib/ical');

// GET /api/availability            -> list of apartments with prices
// GET /api/availability?room=paris -> booked date ranges for that apartment
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  // calendar link read by Airbnb / Booking.com / Lodgers
  if (req.query.ical) {
    const room = String(req.query.ical), ch = String(req.query.for || '');
    if (!ROOMS[room] || !ical.CHANNELS[ch] || !checkSig(`ical:${room}:${ch}`, req.query.sig)) return json(res, 403, { error: 'Not allowed' });
    try { const t = await ical.exportIcs(room, ch); res.statusCode = 200; res.setHeader('Content-Type', 'text/calendar; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); return res.end(t); }
    catch (e) { return json(res, 500, { error: 'Could not build the calendar' }); }
  }
  // daily cron: refresh every connected website calendar
  if (req.query.sync) { const n = await ical.syncStale(0); return json(res, 200, { synced: n }); }
  const id = String(req.query.room || '');
  if (!id) return json(res, 200, { rooms: Object.entries(ROOMS).map(([k, v]) => ({ id: k, ...v })) });
  if (!ROOMS[id]) return json(res, 400, { error: 'Unknown apartment' });
  try {
    await Promise.race([ical.syncStale(10, id), new Promise(r => setTimeout(r, 4000))]);   // keep other websites' bookings fresh before guests see dates
    const now = new Date().toISOString();
    const r = await sb(`bookings?select=check_in,check_out&room=eq.${id}&check_out=gte.${today()}&or=(status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${now}))&order=check_in`);
    if (!r.ok) throw new Error('db');
    json(res, 200, { room: id, booked: r.data.map(x => ({ from: x.check_in, to: x.check_out })) });
  } catch (e) { json(res, 500, { error: 'Could not load availability' }); }
};
