const { sb, bad, crypto, E } = require('./core');

// Who is calling? PIN-only login for the staff page and the other staff tools.
//   Admin  = ADMIN_PIN (falls back to the old STAFF_PIN so nothing breaks on day one)
//   Staff  = a receptionist PIN created by the admin (stored as a keyed hash in the `staff` table)
const h = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(h(a), h(b));
const adminPin = () => E.ADMIN_PIN || E.STAFF_PIN || '';
function hashPin(pin) {
  if (!E.ADMIN_SECRET) throw bad('Server is missing ADMIN_SECRET', 503);
  return crypto.createHmac('sha256', E.ADMIN_SECRET).update('staff-pin:' + String(pin)).digest('hex');
}
const ipOf = req => String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'unknown').split(',')[0].trim().slice(0, 64);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_FAILS = 8, WINDOW_MIN = 15;

async function authenticate(req, pin) {
  pin = String(pin || '').trim();
  const ip = ipOf(req);
  // too many wrong PINs from this address recently?
  try {
    const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
    const r = await sb(`auth_fail?select=id&ip=eq.${encodeURIComponent(ip)}&created_at=gt.${since}&limit=${MAX_FAILS}`);
    if (r.ok && Array.isArray(r.data) && r.data.length >= MAX_FAILS) throw bad(`Too many wrong PINs. Please wait ${WINDOW_MIN} minutes and try again.`, 429);
  } catch (e) { if (e.status === 429) throw e; }

  if (pin && adminPin() && same(pin, adminPin())) return { role: 'admin', id: null, name: 'Admin' };
  if (/^[0-9]{4,8}$/.test(pin)) {
    try {
      const r = await sb(`staff?select=id,full_name,username,shift&pin_hash=eq.${hashPin(pin)}&active=eq.true&limit=1`);
      if (r.ok && r.data && r.data[0]) { const s = r.data[0]; return { role: 'staff', id: s.id, name: s.full_name, username: s.username, shift: s.shift }; }
    } catch (e) { if (e.status === 503) throw e; }
  }
  try { await sb('auth_fail', { method: 'POST', prefer: 'return=minimal', body: { ip } }); } catch (e) { /* table not created yet */ }
  await sleep(900);
  throw bad('Wrong PIN', 403);
}

async function logAction(user, action, detail) {
  try { await sb('staff_log', { method: 'POST', prefer: 'return=minimal', body: { staff_name: user.name, role: user.role, action, detail: String(detail || '').slice(0, 300) } }); } catch (e) { /* logging must never block work */ }
}

module.exports = { authenticate, logAction, hashPin, adminPin, same };
