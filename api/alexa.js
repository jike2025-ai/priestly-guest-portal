'use strict';
const { sb, json, ROOMS, today, crypto } = require('../lib/core');

// Alexa custom skill endpoint: greets the guest by name when the smart lock opens (an Alexa Routine calls the skill).
//   Alexa  -> POST /api/alexa?key=ALEXA_KEY            (standard Alexa skill request; the Echo's deviceId says which room)
//   Tester -> GET  /api/alexa?key=ALEXA_KEY&room=moscow[&hour=15&day=2026-11-06]   (dry run, shows the greeting, changes nothing)
// Env: ALEXA_KEY (secret), ALEXA_SKILL_ID (recommended), ALEXA_GREET_FROM (default 12), ALEXA_RETURN_FROM (default 14)
const E = process.env;
const GREET_FROM = parseInt(E.ALEXA_GREET_FROM || '12', 10);   // before this hour on check-in day: never greet by name (staff are preparing the room)
const RETURN_FROM = parseInt(E.ALEXA_RETURN_FROM || '14', 10); // "welcome back" by name only from this hour (housekeeping works in the morning)

const eq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const esc = s => String(s).replace(/&/g, ' and ').replace(/[<>"']/g, '');
const lagosHour = () => parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }), 10);

function firstName(b) {
  if (b.say_name && b.say_name.trim()) return esc(b.say_name.trim());
  const w = String(b.guest_name || '').replace(/[^\p{L}' -]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return w.length ? esc(w[0].charAt(0).toUpperCase() + w[0].slice(1).toLowerCase()) : '';
}
const GENERIC = 'Welcome to Priestly Apartments. We hope you enjoy your stay.';

// Decide what to say. Pure function: easy to test.
function decide(bookings, day, hour) {
  const ok = (bookings || []).filter(b => b.status === undefined || b.status === 'confirmed')
    .filter(b => b.check_in <= day && b.check_out >= day && !(b.check_out === day && hour >= 12))
    .sort((a, b) => (a.check_in < b.check_in ? 1 : -1));
  const b = ok[0];
  if (!b) return { speech: GENERIC, mark: null };
  const name = firstName(b), room = (ROOMS[b.room] || { name: b.room }).name;
  if (!name) return { speech: GENERIC, mark: null };
  if (b.check_in === day && hour < GREET_FROM) return { speech: GENERIC, mark: null };
  if (!b.greeted_at) {
    return { speech: `Welcome to Priestly Apartments, ${name}. You are in ${room}. Your Wi-Fi details are on your welcome pass. If you need anything, please call the front desk. Enjoy your stay.`, mark: b.reference };
  }
  if (hour >= RETURN_FROM) return { speech: `Welcome back, ${name}.`, mark: null };
  return { speech: GENERIC, mark: null };
}

async function bookingsFor(room, day) {
  const base = `bookings?room=eq.${encodeURIComponent(room)}&status=eq.confirmed&check_in=lte.${day}&check_out=gte.${day}&order=check_in.desc&limit=3`;
  let r = await sb(base + '&select=reference,room,guest_name,check_in,check_out,status,greeted_at,say_name');
  if (!r.ok) r = await sb(base + '&select=reference,room,guest_name,check_in,check_out,status'); // migration not run yet
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

const reply = (res, text) => json(res, 200, { version: '1.0', response: { outputSpeech: { type: 'SSML', ssml: `<speak>${text}</speak>` }, shouldEndSession: true } });

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!E.ALEXA_KEY) return json(res, 503, { error: 'Alexa greeting is not set up yet' });
    if (!eq(url.searchParams.get('key'), E.ALEXA_KEY)) return json(res, 403, { error: 'Forbidden' });

    // Dry run for testing from a phone/browser.
    if (req.method === 'GET') {
      const room = url.searchParams.get('room');
      if (!ROOMS[room]) return json(res, 400, { error: 'Add &room=moscow (or another apartment id)' });
      const day = url.searchParams.get('day') || today(), hour = url.searchParams.has('hour') ? parseInt(url.searchParams.get('hour'), 10) : lagosHour();
      const d = decide(await bookingsFor(room, day), day, hour);
      return json(res, 200, { room, day, hour, speech: d.speech, wouldMarkGreeted: d.mark });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const rq = b.request || {}, sys = (b.context && b.context.System) || {};
    const appId = (sys.application && sys.application.applicationId) || (b.session && b.session.application && b.session.application.applicationId);
    if (E.ALEXA_SKILL_ID && appId !== E.ALEXA_SKILL_ID) return json(res, 403, { error: 'Forbidden' });
    if (!rq.timestamp || Math.abs(Date.now() - Date.parse(rq.timestamp)) > 150000) return json(res, 400, { error: 'Stale request' });

    if (rq.type === 'SessionEndedRequest') return json(res, 200, { version: '1.0', response: {} });
    if (rq.type === 'IntentRequest' && /^AMAZON\.(Help|Stop|Cancel)Intent$/.test((rq.intent || {}).name || '')) return reply(res, 'Welcome to Priestly Apartments.');

    // LaunchRequest or GreetIntent: find the room from the Echo's device id.
    const deviceId = sys.device && sys.device.deviceId;
    let speech = GENERIC;
    if (deviceId) {
      const up = await sb('echo_devices?on_conflict=device_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: { device_id: deviceId, last_seen: new Date().toISOString() } });
      const room = up.ok && up.data && up.data[0] && up.data[0].room;
      if (room && ROOMS[room]) {
        const day = today(), d = decide(await bookingsFor(room, day), day, lagosHour());
        speech = d.speech;
        if (d.mark) await sb(`bookings?reference=eq.${encodeURIComponent(d.mark)}`, { method: 'PATCH', prefer: 'return=minimal', body: { greeted_at: new Date().toISOString() } });
      } else console.log('alexa: unmapped Echo', deviceId);
    }
    reply(res, speech);
  } catch (e) {
    console.error('alexa', e.message);
    reply(res, GENERIC); // never leave the guest with an error voice
  }
};
module.exports.decide = decide;
