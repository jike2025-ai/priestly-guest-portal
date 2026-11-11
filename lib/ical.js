// Calendar sync (iCal) with Airbnb, Booking.com and Lodgers.
//  - exportIcs: our bookings for one apartment, as a calendar those websites can read (guest names are never included)
//  - syncFeed:  read a website's calendar and block those dates in our bookings table (channel = airbnb | booking | lodgers)
const { sb, crypto, sign, today, alertOwner, ROOMS, SITE } = require('./core');

const CHANNELS = { airbnb: 'Airbnb', booking: 'Booking.com', lodgers: 'Lodgers' };
const sigFor = (room, ch) => sign(`ical:${room}:${ch}`);
const exportUrl = (room, ch) => `${SITE}/api/availability?ical=${room}&for=${ch}&sig=${sigFor(room, ch)}`;
const d8 = s => `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}`;
const iso = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const addDay = s => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

async function exportIcs(room, forCh) {
  const now = new Date().toISOString();
  const r = await sb(`bookings?select=reference,check_in,check_out,channel&room=eq.${room}&check_out=gte.${today()}&or=(status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${now}))&order=check_in&limit=1000`);
  if (!r.ok) throw new Error('db');
  const ev = r.data.filter(b => b.channel !== forCh).map(b => ['BEGIN:VEVENT', `UID:${b.reference}@priestlyapartments.com`, `DTSTAMP:${now.replace(/[-:]|\.\d+/g, '')}`, `DTSTART;VALUE=DATE:${d8(b.check_in)}`, `DTEND;VALUE=DATE:${d8(b.check_out)}`, 'SUMMARY:Reserved', 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Priestly Apartments//Availability//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:Priestly ${(ROOMS[room] || {}).name || room}`, ...ev, 'END:VCALENDAR', ''].join('\r\n');
}

// minimal iCal reader: unfolds lines, returns [{uid, start, end}] for dated, non-cancelled events
function parseIcs(text) {
  const t = String(text || '');
  if (!/BEGIN:VCALENDAR/i.test(t)) throw new Error('That link did not return a calendar');
  const lines = t.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out = []; let cur = null;
  for (const ln of lines) {
    if (/^BEGIN:VEVENT/i.test(ln)) { cur = {}; continue; }
    if (/^END:VEVENT/i.test(ln)) { if (cur && cur.start) { if (!cur.end || cur.end <= cur.start) cur.end = addDay(cur.start); if (!cur.cancelled) out.push({ uid: cur.uid || `${cur.start}-${cur.end}`, start: cur.start, end: cur.end }); } cur = null; continue; }
    if (!cur) continue;
    const i = ln.indexOf(':'); if (i < 0) continue;
    const key = ln.slice(0, i).split(';')[0].toUpperCase(), val = ln.slice(i + 1).trim();
    if (key === 'UID') cur.uid = val;
    else if (key === 'STATUS') cur.cancelled = /CANCEL/i.test(val);
    else if (key === 'DTSTART' || key === 'DTEND') { const m = /^(\d{8})/.exec(val); if (m) cur[key === 'DTSTART' ? 'start' : 'end'] = iso(m[1]); }
  }
  return out;
}

const refFor = (ch, room, uid) => `X-${ch}-${room}-${crypto.createHash('sha1').update(uid).digest('hex').slice(0, 10)}`;

async function syncFeed(f) {
  const stamp = async (status, count) => { try { await sb(`ical_feeds?id=eq.${f.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { last_sync: new Date().toISOString(), last_status: String(status).slice(0, 300), last_count: count == null ? null : count } }); } catch (e) { /* ignore */ } };
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
    let txt; try { const r = await fetch(f.url, { signal: ctl.signal, headers: { 'User-Agent': 'PriestlyApartments-CalendarSync/1.0' } }); if (!r.ok) throw new Error('The website answered ' + r.status); txt = await r.text(); } finally { clearTimeout(to); }
    const T = today();
    const events = parseIcs(txt).filter(e => e.end > T);
    const ex = await sb(`bookings?select=reference,check_in,check_out&room=eq.${f.room}&channel=eq.${f.channel}&status=eq.confirmed&reference=like.X-${f.channel}-*&check_out=gte.${T}&limit=1000`);
    if (!ex.ok) throw new Error('db');
    const have = {}; ex.data.forEach(b => have[b.reference] = b);
    const seen = new Set(), conflicts = []; let added = 0, changed = 0, removed = 0;
    for (const e of events) {
      const ref = refFor(f.channel, f.room, e.uid); if (seen.has(ref)) continue; seen.add(ref);
      const cur = have[ref], nights = Math.max(1, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 864e5));
      if (cur && cur.check_in === e.start && cur.check_out === e.end) continue;
      if (cur) {
        const p = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}`, { method: 'PATCH', prefer: 'return=minimal', body: { check_in: e.start, check_out: e.end, nights } });
        if (p.ok) changed++; else conflicts.push(`${e.start} to ${e.end}`);
      } else {
        const p = await sb('bookings', { method: 'POST', prefer: 'return=minimal', body: { reference: ref, room: f.room, check_in: e.start, check_out: e.end, nights, guests: 1, guest_name: `${CHANNELS[f.channel]} booking`, guest_phone: '-', guest_email: 'calendar-sync@priestlyapartments.com', rate: 0, caution: 0, total: 0, status: 'confirmed', channel: f.channel } });
        if (p.ok) added++; else conflicts.push(`${e.start} to ${e.end}`);
      }
    }
    for (const ref of Object.keys(have)) if (!seen.has(ref)) { const p = await sb(`bookings?reference=eq.${encodeURIComponent(ref)}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'cancelled' } }); if (p.ok) removed++; }
    const name = (ROOMS[f.room] || {}).name || f.room;
    if (conflicts.length) {
      await stamp(`${conflicts.length} CLASH: ${conflicts.join(', ')}`, events.length);
      await alertOwner(`DOUBLE BOOKING WARNING: ${name}`, `${CHANNELS[f.channel]} has a booking for ${name} on ${conflicts.join(' and ')} that clashes with a booking already on our system. Please check both and cancel one.`);
    } else await stamp(`OK: ${added} new, ${changed} changed, ${removed} removed`, events.length);
    return { ok: !conflicts.length, added, changed, removed, conflicts, events: events.length };
  } catch (e) { await stamp('FAILED: ' + e.message, null); return { ok: false, error: e.message }; }
}

// refresh feeds older than `mins` minutes (optionally one apartment only); never throws
async function syncStale(mins, room) {
  try {
    const cut = new Date(Date.now() - mins * 60000).toISOString();
    const r = await sb(`ical_feeds?select=*${room ? `&room=eq.${room}` : ''}&or=(last_sync.is.null,last_sync.lt.${cut})`);
    if (!r.ok || !Array.isArray(r.data)) return 0;
    await Promise.all(r.data.map(syncFeed)); return r.data.length;
  } catch (e) { return 0; }
}
module.exports = { CHANNELS, exportUrl, sigFor, exportIcs, parseIcs, syncFeed, syncStale };
