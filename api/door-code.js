const { cors, json, bad, ROOMS, doorCodeFor } = require('../lib/core');
const { authenticate, logAction } = require('../lib/staff');

// POST /api/door-code {room, pin}  -> staff only (welcome card page). Returns the smart-lock passcode for that apartment.
// Codes live in the DOOR_CODES environment variable on the server, never in the website files.
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!process.env.DOOR_CODES) throw bad('Door passcodes are not set up yet', 503);
    const user = await authenticate(req, b.pin);
    if (!ROOMS[b.room]) throw bad('Unknown apartment');
    const code = doorCodeFor(b.room);
    if (!code) throw bad('No passcode saved for this apartment', 404);
    await logAction(user, 'door code viewed', ROOMS[b.room].name);
    json(res, 200, { code });
  } catch (e) {
    if (!e.status) console.error('door-code', e.message);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
};
