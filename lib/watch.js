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
module.exports = { missedWelcomes };
