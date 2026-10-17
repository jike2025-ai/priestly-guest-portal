const { cors, json, bad, ROOMS, doorCodeFor, crypto } = require('../lib/core');

// POST /api/door-code {room, pin}  -> staff only (welcome card page). Returns the smart-lock passcode for that apartment.
// Codes live in the DOOR_CODES environment variable on the server, never in the website files.
const h = s => crypto.createHash('sha256').update(String(s)).digest();
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const pin = process.env.STAFF_PIN;
    if (!pin || !process.env.DOOR_CODES) throw bad('Door passcodes are not set up yet', 503);
    if (!crypto.timingSafeEqual(h(b.pin), h(pin))) { await new Promise(r => setTimeout(r, 700)); throw bad('Wrong staff PIN', 403); }
    if (!ROOMS[b.room]) throw bad('Unknown apartment');
    const code = doorCodeFor(b.room);
    if (!code) throw bad('No passcode saved for this apartment', 404);
    json(res, 200, { code });
  } catch (e) {
    if (!e.status) console.error('door-code', e.message);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
};
