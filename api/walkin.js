const { cors, json, bad, sb, ROOMS, today, quote, crypto, alertOwner, fd, naira } = require('../lib/core');
const { authenticate, logAction, can, capsOf } = require('../lib/staff');

// POST /api/walkin  (staff page: receptionists and admin, PIN only)
//   {pin, action:'login'}                         -> {role, name, shiftId}   (starts a tracked shift)
//   {pin, action:'ping', shiftId}                 -> keeps the shift "last seen" fresh
//   {pin, action:'logout', shiftId}               -> ends the shift
//   {pin, action:'overview'}                      -> apartments, bookings, housekeeping status
//   {pin, action:'create', room, checkIn, checkOut, lastName, firstName, birthDate, sex, address, phone, email, city, state, nin, guests, paid, note}
//   {pin, action:'request_change', reference, reason} -> receptionist asks the admin to cancel/correct a walk-in
//   {pin, action:'requests'}                      -> pending requests + decisions of the last 3 days
//   {pin, action:'cancel', reference}             -> walk-ins only (staff: their own, within 1 hour; admin: any)
//   {pin, action:'room_status', room, status, note}   status: clean | dirty | maintenance
//   {pin, action:'checkout', reference}            -> guest has left (early or on time)
//   {pin, action:'late', reference, on:true|false} -> guest still in the room after noon (or undo)
//   {pin, action:'card', reference}               -> full details for the printed registration card (logged)
//   {pin, action:'printed', reference}            -> marks the card as printed (hard copy filed)
//   {pin, action:'nin', reference}                -> admin only, reveals the full NIN (logged)
// A walk-in is saved in the SAME bookings table as online bookings, so the database's no_double_booking
// rule and the online calendar treat it exactly the same: those dates disappear from the website instantly.
const clean = (s, n) => String(s || '').replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const BASE = 'reference,room,check_in,check_out,nights,guests,guest_name,guest_phone,guest_email,rate,caution,total,status,channel,special_requests,created_at,paid_at,hold_expires_at';
const EXTRA = 'gender,nin,home_address,children,birth_date,city,state,payment_method,recorded_by';
const PRINT = 'printed_at,printed_by';
const STAY = 'checked_out_at,checked_out_by,late_stay';
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const ageOn = (dob, ref) => { const d = new Date(dob + 'T00:00:00Z'), r = new Date(ref + 'T00:00:00Z'); let a = r.getUTCFullYear() - d.getUTCFullYear(); if (r.getUTCMonth() < d.getUTCMonth() || (r.getUTCMonth() === d.getUTCMonth() && r.getUTCDate() < d.getUTCDate())) a--; return a; };
const SETUP_REQ = 'The requests table has not been created yet. Ask the developer to run supabase/migration-requests.sql in Supabase.';
const SETUP = 'The staff database update has not been run yet. Ask the developer to run supabase/staff-setup.sql in Supabase.';

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!process.env.ADMIN_PIN && !process.env.STAFF_PIN && !process.env.ADMIN_SECRET) throw bad('Staff login is not set up yet', 503);
    const user = await authenticate(req, b.pin);
    // what each action needs; the CEO role is read-only (view), a receptionist books and prints, a supervisor can cancel any walk-in, a manager sees NINs
    const NEED = { login: 'view', ping: 'view', logout: 'view', overview: 'view', requests: 'view', create: 'book', cancel: 'view', request_change: 'request', room_status: 'housekeeping', checkout: 'stay', late: 'stay', card: 'print', printed: 'print', nin: 'nin' };
    if (NEED[b.action] && !can(user, NEED[b.action])) throw bad('Your role is view-only for this. Ask a manager or the admin.', 403);
    const admin = can(user, 'cancel_any');
    const track = user.role !== 'ceo';   // executives are not clocked in as a shift

    if (b.action === 'login') {
      let shiftId = null;
      try {
        const r = !track ? { ok: false } : await sb('staff_shifts', { method: 'POST', prefer: 'return=representation', body: { staff_id: user.id, staff_name: user.name, role: user.role } });
        if (r.ok && r.data && r.data[0]) shiftId = r.data[0].id;
      } catch (e) { /* tracking table not created yet: login still works */ }
      return json(res, 200, { role: user.role, name: user.name, caps: capsOf(user), shift: user.shift || null, shiftId });
    }

    if (b.action === 'ping' || b.action === 'logout') {
      const id = String(b.shiftId || '');
      if (/^[0-9a-f-]{36}$/.test(id)) {
        const body = b.action === 'logout' ? { ended_at: new Date().toISOString(), last_seen: new Date().toISOString() } : { last_seen: new Date().toISOString() };
        await sb(`staff_shifts?id=eq.${id}&ended_at=is.null`, { method: 'PATCH', prefer: 'return=minimal', body });
      }
      return json(res, 200, { ok: true });
    }

    if (b.action === 'overview') {
      const now = new Date().toISOString();
      const from = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const q = cols => `bookings?select=${cols}&check_out=gte.${from}&or=(status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${now}))&order=check_in&limit=1000`;
      let tracking = true, stay = true; // columns added by migration-printed.sql / migration-checkout.sql
      let r = await sb(q(BASE + ',' + EXTRA + ',' + PRINT + ',' + STAY));
      if (!r.ok) { stay = false; r = await sb(q(BASE + ',' + EXTRA + ',' + PRINT)); }
      if (!r.ok) { tracking = false; r = await sb(q(BASE + ',' + EXTRA)); }
      if (!r.ok) r = await sb(q(BASE)); // database update not run yet: still show the dashboard
      if (!r.ok) throw new Error('overview failed');
      const bookings = r.data.map(x => { const o = Object.assign({}, x); o.nin_last4 = x.nin ? String(x.nin).slice(-4) : ''; delete o.nin; return o; });
      const sid = String(b.shiftId || '');
      if (/^[0-9a-f-]{36}$/.test(sid)) await sb(`staff_shifts?id=eq.${sid}&ended_at=is.null`, { method: 'PATCH', prefer: 'return=minimal', body: { last_seen: new Date().toISOString() } });
      let housekeeping = {};
      const rs = await sb('room_status?select=room,status,note,updated_by,updated_at');
      if (rs.ok && Array.isArray(rs.data)) rs.data.forEach(x => { housekeeping[x.room] = x; });
      return json(res, 200, { today: today(), me: { role: user.role, name: user.name, caps: capsOf(user) }, rooms: Object.entries(ROOMS).map(([id, v]) => ({ id, ...v })), bookings, housekeeping, tracking, stay });
    }

    if (b.action === 'create') {
      if (!ROOMS[b.room]) throw bad('Please choose an apartment');
      const first = clean(b.firstName, 40), last = clean(b.lastName, 40);
      if (first.length < 2) throw bad('Please enter the guest first name');
      if (last.length < 2) throw bad('Please enter the guest last name');
      const dob = String(b.birthDate || '');
      if (!isDate(dob)) throw bad('Please enter the guest date of birth');
      const age = ageOn(dob, today());
      if (age < 18) throw bad('The registered guest must be 18 or older');
      if (age > 110) throw bad('Please check the date of birth');
      const sex = ['Male', 'Female'].includes(b.sex) ? b.sex : '';
      if (!sex) throw bad('Please select the guest sex');
      const address = clean(b.address, 200); if (address.length < 5) throw bad('Please enter the guest address');
      const city = clean(b.city, 60); if (city.length < 2) throw bad('Please enter the city');
      const state = clean(b.state, 60); if (state.length < 2) throw bad('Please enter the state');
      const phone = clean(b.phone, 20);
      if (!/^\+?[0-9]{7,15}$/.test(phone.replace(/[\s-]/g, ''))) throw bad('Please enter a valid phone number');
      const email = clean(b.email, 120).toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('That email address does not look right');
      const nin = String(b.nin || '').replace(/\s/g, '');
      if (!/^[0-9]{11}$/.test(nin)) throw bad('Please enter the 11-digit NIN');
      const note = clean(b.note, 200);
      const guests = Math.min(10, Math.max(1, parseInt(b.guests, 10) || 1));
      const paid = ['cash', 'transfer', 'pos', 'unpaid'].includes(b.paid) ? b.paid : 'cash';
      const q = quote(b.room, b.checkIn, b.checkOut);
      await sb(`bookings?status=eq.pending&hold_expires_at=lt.${new Date().toISOString()}`, { method: 'PATCH', body: { status: 'expired' } });
      const reference = 'PA-W-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      const name = first + ' ' + last;
      const row = {
        reference, room: b.room, check_in: b.checkIn, check_out: b.checkOut, nights: q.nights, guests,
        guest_name: name, guest_phone: phone, guest_email: email || 'walk-in@priestlyapartments.com',
        rate: q.rate, caution: q.caution, total: q.total, status: 'confirmed', paid_at: paid === 'unpaid' ? null : new Date().toISOString(), channel: 'walk-in',
        gender: sex, nin, home_address: address, birth_date: dob, city, state, payment_method: paid, recorded_by: user.name,
        special_requests: ('WALK-IN at reception. Payment: ' + paid + (note ? '. ' + note : '')).slice(0, 500)
      };
      const ins = await sb('bookings', { method: 'POST', prefer: 'return=minimal', body: row });
      if (ins.status === 409) throw bad('Those dates are already booked for this apartment (online or at reception). Please choose other dates.', 409);
      if (ins.status === 400 && JSON.stringify(ins.data || '').match(/column|schema/i)) throw bad(SETUP, 503);
      if (!ins.ok) { console.error('walkin insert', ins.status, JSON.stringify(ins.data).slice(0, 200)); throw new Error('insert failed'); }
      await logAction(user, 'walk-in booking', `${reference}: ${name}, ${ROOMS[b.room].name} ${b.checkIn} to ${b.checkOut}, ${naira(q.total)}, ${paid}`);
      await alertOwner(`WALK-IN booked: ${ROOMS[b.room].name} ${b.checkIn} to ${b.checkOut}`, `${name} (${phone}) booked ${ROOMS[b.room].name} from ${fd(b.checkIn)} to ${fd(b.checkOut)} at reception. Recorded by ${user.name}. Payment: ${paid}. Reference ${reference}. Total ${naira(q.total)} incl. caution fee. These dates are now blocked on the website.`);
      return json(res, 200, { reference, total: q.total, nights: q.nights });
    }

    if (b.action === 'cancel') {
      const ref = clean(b.reference, 40);
      const f = await sb(`bookings?select=reference,guest_name,room,check_in,check_out,created_at,recorded_by&reference=eq.${encodeURIComponent(ref)}&channel=eq.walk-in&status=eq.confirmed&limit=1`);
      const bk = f.ok && f.data && f.data[0];
      if (!bk) throw bad('That walk-in booking was not found (online bookings cannot be cancelled here)', 404);
      if (!admin && !(bk.recorded_by === user.name && Date.now() - Date.parse(bk.created_at) < 3600e3)) throw bad('Only a supervisor, manager or the admin can cancel this booking now. Staff can only cancel their own booking within 1 hour of saving it.', 403);
      const r = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}&channel=eq.walk-in&status=eq.confirmed`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'cancelled' } });
      if (!r.ok) throw new Error('cancel failed');
      await logAction(user, 'walk-in cancelled', `${ref}: ${bk.guest_name}, ${bk.room} ${bk.check_in} to ${bk.check_out}`);
      await alertOwner(`WALK-IN cancelled ${ref}`, `Walk-in booking ${ref} (${bk.guest_name}, ${bk.room}, ${bk.check_in} to ${bk.check_out}) was cancelled by ${user.name}. The dates are free again.`);
      return json(res, 200, { ok: true });
    }

    if (b.action === 'request_change') {
      const ref = clean(b.reference, 40), reason = clean(b.reason, 300), enc = encodeURIComponent(ref);
      if (reason.length < 5) throw bad('Please say what is wrong (for example: wrong name or wrong dates)');
      const f = await sb(`bookings?select=reference,guest_name,room,check_in,check_out&reference=eq.${enc}&channel=eq.walk-in&status=eq.confirmed&limit=1`);
      const bk = f.ok && f.data && f.data[0];
      if (!bk) throw bad('That walk-in booking was not found, or it is already cancelled', 404);
      const ex = await sb(`booking_requests?select=id&reference=eq.${enc}&status=eq.pending&limit=1`);
      if (!ex.ok) throw bad(SETUP_REQ, 503);
      if (ex.data && ex.data[0]) throw bad('A request for this booking is already waiting for the admin');
      const r = await sb('booking_requests', { method: 'POST', prefer: 'return=minimal', body: { reference: ref, guest_name: bk.guest_name, room: bk.room, check_in: bk.check_in, check_out: bk.check_out, reason, requested_by: user.name } });
      if (!r.ok) throw bad(SETUP_REQ, 503);
      await logAction(user, 'cancel requested', `${ref}: ${bk.guest_name}. Reason: ${reason}`);
      try { await alertOwner(`Cancel request ${ref}`, `${user.name} asked you to cancel or correct walk-in booking ${ref} (${bk.guest_name}, ${bk.room}, ${bk.check_in} to ${bk.check_out}).\n\nReason: ${reason}\n\nOpen the staff page > Requests to decide.`); } catch (e) { /* email is a bonus */ }
      return json(res, 200, { ok: true });
    }

    if (b.action === 'requests') {
      const since = encodeURIComponent(new Date(Date.now() - 3 * 864e5).toISOString());
      const r = await sb(`booking_requests?select=id,reference,guest_name,room,check_in,check_out,reason,requested_by,created_at,status,resolved_by,resolved_at,note&or=(status.eq.pending,resolved_at.gt.${since})&order=created_at.desc&limit=50`);
      return json(res, 200, { ready: r.ok, requests: r.ok && Array.isArray(r.data) ? r.data : [] });
    }

    if (b.action === 'room_status') {
      if (!ROOMS[b.room]) throw bad('Unknown apartment');
      const status = ['clean', 'dirty', 'maintenance'].includes(b.status) ? b.status : '';
      if (!status) throw bad('Unknown status');
      const note = clean(b.note, 160);
      const r = await sb('room_status?on_conflict=room', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { room: b.room, status, note: note || null, updated_by: user.name, updated_at: new Date().toISOString() } });
      if (!r.ok) throw bad(SETUP, 503);
      await logAction(user, 'room status', `${ROOMS[b.room].name}: ${status}${note ? ' (' + note + ')' : ''}`);
      return json(res, 200, { ok: true });
    }

    if (b.action === 'checkout' || b.action === 'late') {
      // checkout: guest has left (works early or on time). late: guest is still in the room past noon (or undo it).
      const ref = clean(b.reference, 40);
      const f = await sb(`bookings?select=reference,guest_name,room,check_in,check_out,status&reference=eq.${encodeURIComponent(ref)}&limit=1`);
      const bk = f.ok && f.data && f.data[0];
      if (!bk || bk.status !== 'confirmed') throw bad('Booking not found', 404);
      const body = b.action === 'checkout'
        ? { checked_out_at: new Date().toISOString(), checked_out_by: user.name, late_stay: false }
        : (b.on === false ? { late_stay: false, checked_out_at: null, checked_out_by: null } : { late_stay: true, checked_out_at: null, checked_out_by: null });
      const r = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}`, { method: 'PATCH', prefer: 'return=minimal', body });
      if (!r.ok) throw bad('The check-out tracking has not been set up yet. Ask the developer to run supabase/migration-checkout.sql in Supabase.', 503);
      await logAction(user, b.action === 'checkout' ? 'checked out' : (b.on === false ? 'late stay cleared' : 'late stay'), `${ref}: ${bk.guest_name}, ${ROOMS[bk.room] ? ROOMS[bk.room].name : bk.room}`);
      return json(res, 200, { ok: true });
    }

    if (b.action === 'card') {
      // everything needed for the printed registration card (online or walk-in). Staff and admin; every print is logged.
      const ref = clean(b.reference, 40);
      const r = await sb(`bookings?select=${BASE},${EXTRA}&reference=eq.${encodeURIComponent(ref)}&limit=1`);
      const bk = r.ok && r.data && r.data[0];
      if (!bk) throw bad('Booking not found', 404);
      await logAction(user, 'card printed', `${ref}: ${bk.guest_name}`);
      return json(res, 200, { booking: bk });
    }

    if (b.action === 'printed') {
      const ref = clean(b.reference, 40);
      const r = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}`, { method: 'PATCH', prefer: 'return=minimal', body: { printed_at: new Date().toISOString(), printed_by: user.name } });
      if (!r.ok) throw bad('Run supabase/migration-printed.sql in Supabase to track printed cards.', 503);
      return json(res, 200, { ok: true });
    }

    if (b.action === 'nin') {
      if (!can(user, 'nin')) throw bad('Only a manager or the admin can view full NIN numbers', 403);
      const ref = clean(b.reference, 40);
      const r = await sb(`bookings?select=nin,guest_name&reference=eq.${encodeURIComponent(ref)}&limit=1`);
      if (!r.ok || !r.data || !r.data[0]) throw bad('Booking not found', 404);
      await logAction(user, 'NIN viewed', `${ref}: ${r.data[0].guest_name}`);
      return json(res, 200, { nin: r.data[0].nin || '' });
    }

    throw bad('Unknown action');
  } catch (e) {
    if (!e.status) console.error('walkin', e.message);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
};
