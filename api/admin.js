const { cors, json, bad, sb, ROOMS, today } = require('../lib/core');
const { authenticate, logAction, hashPin, adminPin, same } = require('../lib/staff');

// POST /api/admin  (ADMIN ONLY, PIN login)
//   {pin, action:'staff_list'}
//   {pin, action:'staff_add', full_name, username, phone, email, pin_new, shift}
//   {pin, action:'staff_update', id, active?, shift?, full_name?, phone?, email?, pin_new?}
//   {pin, action:'shifts'}      who worked when
//   {pin, action:'log'}         activity log
//   {pin, action:'analytics'}   revenue, occupancy, rooms, payments, staff
const clean = (s, n) => String(s || '').replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const SETUP = 'The staff database update has not been run yet. Run supabase/staff-setup.sql in Supabase (SQL Editor).';
const dn = s => Date.parse(s + 'T00:00:00Z') / 864e5;
const addD = (s, n) => new Date((dn(s) + n) * 864e5).toISOString().slice(0, 10);

function checkPin(p) {
  p = String(p || '').trim();
  if (!/^[0-9]{4,8}$/.test(p)) throw bad('The PIN must be 4 to 8 digits');
  if (adminPin() && same(p, adminPin())) throw bad('That PIN is not allowed. Choose a different one.');
  return p;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const user = await authenticate(req, b.pin);
    if (user.role !== 'admin') throw bad('Admin only', 403);

    if (b.action === 'staff_list') {
      const r = await sb('staff?select=id,username,full_name,phone,email,shift,active,created_at&order=created_at');
      if (!r.ok) throw bad(SETUP, 503);
      // last seen per staff
      const s = await sb('staff_shifts?select=staff_id,started_at,last_seen,ended_at&order=started_at.desc&limit=500');
      const last = {};
      (s.ok ? s.data : []).forEach(x => { if (x.staff_id && !last[x.staff_id]) last[x.staff_id] = x; });
      return json(res, 200, { staff: r.data.map(x => ({ ...x, last: last[x.id] || null })) });
    }

    if (b.action === 'staff_add') {
      const full = clean(b.full_name, 80), username = clean(b.username, 24).toLowerCase();
      if (full.length < 3) throw bad('Please enter the full name');
      if (!/^[a-z0-9_.-]{3,24}$/.test(username)) throw bad('Username: 3 to 24 letters or numbers, no spaces');
      const phone = clean(b.phone, 20); if (phone && !/^\+?[0-9]{7,15}$/.test(phone.replace(/[\s-]/g, ''))) throw bad('That phone number does not look right');
      const email = clean(b.email, 120).toLowerCase(); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('That email does not look right');
      const shift = ['morning', 'night', 'any'].includes(b.shift) ? b.shift : 'any';
      const pin = checkPin(b.pin_new);
      const r = await sb('staff', { method: 'POST', prefer: 'return=minimal', body: { username, full_name: full, phone: phone || null, email: email || null, role: 'receptionist', shift, pin_hash: hashPin(pin) } });
      if (r.status === 409) throw bad('That username or PIN is already used by another staff member. Choose a different one.', 409);
      if (!r.ok) throw bad(SETUP, 503);
      await logAction(user, 'staff added', `${full} (${username}), ${shift} shift`);
      return json(res, 200, { ok: true });
    }

    if (b.action === 'staff_update') {
      const id = String(b.id || ''); if (!/^[0-9a-f-]{36}$/.test(id)) throw bad('Unknown staff member');
      const body = {};
      if (typeof b.active === 'boolean') body.active = b.active;
      if (b.shift) { if (!['morning', 'night', 'any'].includes(b.shift)) throw bad('Unknown shift'); body.shift = b.shift; }
      if (b.full_name) { const n = clean(b.full_name, 80); if (n.length < 3) throw bad('Please enter the full name'); body.full_name = n; }
      if (b.phone !== undefined) body.phone = clean(b.phone, 20) || null;
      if (b.email !== undefined) body.email = clean(b.email, 120).toLowerCase() || null;
      if (b.pin_new) body.pin_hash = hashPin(checkPin(b.pin_new));
      if (!Object.keys(body).length) throw bad('Nothing to change');
      const r = await sb(`staff?id=eq.${id}`, { method: 'PATCH', prefer: 'return=representation', body });
      if (r.status === 409) throw bad('That PIN is already used by another staff member. Choose a different one.', 409);
      if (!r.ok || !r.data || !r.data[0]) throw bad('Staff member not found', 404);
      await logAction(user, 'staff updated', `${r.data[0].full_name}: ${Object.keys(body).map(k => k === 'pin_hash' ? 'PIN reset' : k + '=' + body[k]).join(', ')}`);
      return json(res, 200, { ok: true });
    }

    if (b.action === 'shifts') {
      const r = await sb('staff_shifts?select=id,staff_name,role,started_at,last_seen,ended_at&order=started_at.desc&limit=300');
      if (!r.ok) throw bad(SETUP, 503);
      const now = Date.now();
      return json(res, 200, { shifts: r.data.map(x => {
        const end = Date.parse(x.ended_at || x.last_seen), start = Date.parse(x.started_at);
        return { ...x, minutes: Math.max(0, Math.round((end - start) / 60000)), online: !x.ended_at && now - Date.parse(x.last_seen) < 6 * 60000 };
      }) });
    }

    if (b.action === 'log') {
      const r = await sb('staff_log?select=staff_name,role,action,detail,created_at&order=created_at.desc&limit=300');
      if (!r.ok) throw bad(SETUP, 503);
      return json(res, 200, { log: r.data });
    }

    if (b.action === 'analytics') {
      const T = today(), since = addD(T, -183);
      const q = cols => `bookings?select=${cols}&status=eq.confirmed&check_out=gte.${since}&order=check_in&limit=3000`;
      const base = 'reference,room,check_in,check_out,nights,rate,caution,total,channel,created_at';
      let r = await sb(q(base + ',payment_method,recorded_by'));
      if (!r.ok) r = await sb(q(base));
      if (!r.ok) throw new Error('analytics failed');
      const bk = r.data, nRooms = Object.keys(ROOMS).length;
      // revenue per month (room income only, caution fee is refundable), by check-in month
      const months = [];
      for (let i = 5; i >= 0; i--) { const d = new Date(T + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - i, 1); months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }), online: 0, walkin: 0, count: 0 }); }
      bk.forEach(x => { const m = months.find(y => y.key === x.check_in.slice(0, 7)); if (!m) return; const v = x.nights * x.rate; if (x.channel === 'walk-in') m.walkin += v; else m.online += v; m.count++; });
      // occupancy: share of apartment-nights booked
      const occ = (from, days) => { let n = 0; bk.forEach(x => { for (let i = 0; i < days; i++) { const d = addD(from, i); if (d >= x.check_in && d < x.check_out) n++; } }); return Math.round(n / (nRooms * days) * 100); };
      // per apartment, last 90 days
      const rooms = Object.entries(ROOMS).map(([id, v]) => ({ id, name: v.name, tier: v.tier, nights: 0, revenue: 0, bookings: 0 }));
      const from90 = addD(T, -90);
      bk.forEach(x => { const ro = rooms.find(y => y.id === x.room); if (!ro || x.check_in < from90) return; ro.nights += x.nights; ro.revenue += x.nights * x.rate; ro.bookings++; });
      // payments + staff (walk-ins)
      const pay = { cash: { n: 0, v: 0 }, transfer: { n: 0, v: 0 }, pos: { n: 0, v: 0 }, unpaid: { n: 0, v: 0 }, online: { n: 0, v: 0 } };
      const staff = {};
      bk.forEach(x => {
        if (x.created_at.slice(0, 10) < addD(T, -30)) return;
        if (x.channel !== 'walk-in') { pay.online.n++; pay.online.v += x.total; return; }
        const k = pay[x.payment_method] ? x.payment_method : 'cash'; pay[k].n++; pay[k].v += x.total;
        const nm = x.recorded_by || 'Unknown'; staff[nm] = staff[nm] || { name: nm, bookings: 0, total: 0 }; staff[nm].bookings++; staff[nm].total += x.total;
      });
      return json(res, 200, { months, occupancy: { last30: occ(addD(T, -30), 30), next30: occ(T, 30) }, rooms, payments: pay, staff: Object.values(staff).sort((a, c) => c.total - a.total) });
    }

    throw bad('Unknown action');
  } catch (e) {
    if (!e.status) console.error('admin', e.message);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
};
