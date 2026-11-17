// Safety net: if a guest checked in today but the Echo has not greeted them by 2 pm, email the owners once so staff can step in.
const { sb, today, alertOwner, ROOMS } = require('./core');
const lagosHour = () => parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }), 10);
async function missedWelcomes() {
  try {
    const h = lagosHour(); if (h < 14 || h >= 23) return 0;
    const cut = new Date(Date.now() - 90 * 60000).toISOString();
    const r = await sb(`bookings?select=reference,room,guest_name,created_at&status=eq.confirmed&check_in=eq.${today()}&greeted_at=is.null&created_at=lt.${cut}&reference=not.like.X-*&limit=20`);
    if (!r.ok || !Array.isArray(r.data) || !r.data.length) return 0;
    let n = 0;
    for (const b of r.data) {
      const ex = await sb(`staff_log?select=id&action=eq.welcome%20missed%20alert&detail=like.${encodeURIComponent(b.reference)}*&limit=1`);
      if (!ex.ok || (ex.data && ex.data.length)) continue;
      await sb('staff_log', { method: 'POST', prefer: 'return=minimal', body: { staff_name: 'System', role: 'system', action: 'welcome missed alert', detail: `${b.reference}: ${b.guest_name}, ${(ROOMS[b.room] || {}).name || b.room}` } });
      await alertOwner(`WELCOME NOT PLAYED: ${(ROOMS[b.room] || {}).name || b.room}`, `${b.guest_name} (${b.reference}) is booked in ${(ROOMS[b.room] || {}).name || b.room} today, but the Alexa welcome has not played yet. Please check the Echo and motion sensor, or send the welcome with the Alexa app's Announce feature.`);
      n++;
    }
    return n;
  } catch (e) { return 0; }
}

// Mark an apartment "needs cleaning" (dirty). Never overwrites maintenance. Returns true if it changed anything.
async function markDirty(room, by, note) {
  try {
    if (!ROOMS[room]) return false;
    const cur = await sb(`room_status?select=status&room=eq.${encodeURIComponent(room)}&limit=1`);
    const st = cur.ok && cur.data && cur.data[0] && cur.data[0].status;
    if (st === 'maintenance' || st === 'dirty') return false;
    const r = await sb('room_status?on_conflict=room', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { room, status: 'dirty', note: note || 'Guest checked out', updated_by: by || 'System', updated_at: new Date().toISOString() } });
    return !!r.ok;
  } catch (e) { return false; }
}

// A guest's stay ends at the moment staff press "checked out", or at 12:00 noon (Lagos) on the check-out day.
// From then on the apartment is marked "needs cleaning", unless housekeeping already updated it after that moment.
async function autoDirty() {
  try {
    const from = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const base = `bookings?select=room,check_out,%COLS%&status=eq.confirmed&check_out=gte.${from}&check_out=lte.${today()}&limit=300`;
    let r = await sb(base.replace('%COLS%', 'checked_out_at,late_stay'));
    if (!r.ok) r = await sb(base.replace(',%COLS%', ''));
    if (!r.ok || !Array.isArray(r.data) || !r.data.length) return 0;
    const now = Date.now(), last = {};
    for (const b of r.data) {
      if (b.late_stay && !b.checked_out_at) continue; // guest is still in the room
      const t = b.checked_out_at ? Date.parse(b.checked_out_at) : Date.parse(b.check_out + 'T12:00:00+01:00');
      if (!t || t > now) continue;
      if (!last[b.room] || t > last[b.room]) last[b.room] = t;
    }
    const rooms = Object.keys(last); if (!rooms.length) return 0;
    const rs = await sb('room_status?select=room,status,updated_at');
    const have = {}; if (rs.ok && Array.isArray(rs.data)) rs.data.forEach(x => { have[x.room] = x; });
    let n = 0;
    for (const room of rooms) {
      const h = have[room];
      if (h && (h.status === 'maintenance' || h.status === 'dirty')) continue;
      if (h && Date.parse(h.updated_at) >= last[room]) continue; // housekeeping already dealt with it after the guest left
      if (await markDirty(room, 'System', 'Guest checked out')) {
        n++;
        await sb('staff_log', { method: 'POST', prefer: 'return=minimal', body: { staff_name: 'System', role: 'system', action: 'needs cleaning', detail: `${(ROOMS[room] || {}).name || room}: marked automatically after check-out` } });
      }
    }
    return n;
  } catch (e) { return 0; }
}
module.exports = { missedWelcomes, autoDirty, markDirty };
