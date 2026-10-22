// POST /api/wifi-voucher
// Used by card.html (staff only). Hands out the next unused Wi-Fi voucher
// for a guest. The voucher lasts until check-out day (noon, Lagos time).
//
// Body: { pin, name, room, checkIn: "YYYY-MM-DD", checkOut: "YYYY-MM-DD" }
// Reply: { username, password, expires }

const { supa, safeEqual, cors, readBody, validDate, daysBetween, expiryFor } = require('../lib/wifi');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const b = readBody(req);

    if (!process.env.STAFF_PIN) return res.status(500).json({ error: 'STAFF_PIN is not set on the server' });
    if (!safeEqual(b.pin, process.env.STAFF_PIN)) {
      await sleep(1000); // slows down PIN guessing
      return res.status(401).json({ error: 'Wrong staff PIN' });
    }

    const name = String(b.name || '').trim().slice(0, 100);
    const room = String(b.room || '').trim().slice(0, 60);
    const checkIn = String(b.checkIn || '');
    const checkOut = String(b.checkOut || '');

    if (!name) return res.status(400).json({ error: 'Enter the guest name first' });
    if (!room) return res.status(400).json({ error: 'Choose the apartment first' });
    if (!validDate(checkIn) || !validDate(checkOut)) return res.status(400).json({ error: 'Enter both check-in and check-out dates' });

    const nights = daysBetween(checkIn, checkOut);
    if (nights < 0) return res.status(400).json({ error: 'Check-out is before check-in' });
    if (nights > 90) return res.status(400).json({ error: 'Stay is longer than 90 days. Check the dates.' });

    const expires = expiryFor(checkOut);
    if (expires.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'That check-out time has already passed. Check the dates.' });
    }

    const r = await supa('rpc/assign_wifi_voucher', {
      method: 'POST',
      body: { p_guest: name, p_room: room, p_check_in: checkIn, p_check_out: checkOut, p_expires: expires.toISOString() },
    });

    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!row || !row.out_username) {
      return res.status(503).json({ error: 'No unused vouchers right now. The router refills every 5 minutes, try again shortly.' });
    }

    return res.status(200).json({ username: row.out_username, password: row.out_password, expires: row.out_expires });
  } catch (e) {
    return res.status(500).json({ error: 'Could not get a voucher: ' + (e && e.message ? e.message : 'unknown error') });
  }
};
