const { cors, json, sb, ROOMS, today } = require('../lib/core');

// GET /api/availability            -> list of apartments with prices
// GET /api/availability?room=paris -> booked date ranges for that apartment
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  const id = String(req.query.room || '');
  if (!id) return json(res, 200, { rooms: Object.entries(ROOMS).map(([k, v]) => ({ id: k, ...v })) });
  if (!ROOMS[id]) return json(res, 400, { error: 'Unknown apartment' });
  try {
    const now = new Date().toISOString();
    const r = await sb(`bookings?select=check_in,check_out&room=eq.${id}&check_out=gte.${today()}&or=(status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${now}))&order=check_in`);
    if (!r.ok) throw new Error('db');
    json(res, 200, { room: id, booked: r.data.map(x => ({ from: x.check_in, to: x.check_out })) });
  } catch (e) { json(res, 500, { error: 'Could not load availability' }); }
};
