const { cors, json, sb, bad, today, naira, fd, roomLabel, mail, owners, emailHtml, adminLink, SITE } = require('../lib/core');

// POST /api/refund-request {ref, email, note, bank}
// The guest asks for their caution fee back. We record it and alert the owners; nothing is refunded yet.
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ref = String(b.ref || ''), email = String(b.email || '').trim().toLowerCase();
    const note = String(b.note || '').trim().slice(0, 500), bank = String(b.bank || '').trim().slice(0, 200);
    if (!/^PA-[A-F0-9]{16}$/.test(ref)) throw bad('Invalid reference');
    const q = await sb(`bookings?reference=eq.${ref}&select=*`);
    const k = q.data && q.data[0];
    if (!k || k.guest_email !== email) throw bad('We could not match that email to this booking', 404);
    if (k.status !== 'confirmed') throw bad('This booking is not confirmed');
    if (today() < k.check_out) throw bad('You can request your caution fee refund from check-out day (' + fd(k.check_out) + ')');
    const u = await sb(`bookings?reference=eq.${ref}&refund_status=eq.none`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { refund_status: 'requested', refund_requested_at: new Date().toISOString(), refund_note: note || null, refund_bank: bank || null }
    });
    if (!u.data || !u.data.length) throw bad('A refund request already exists for this booking', 409);
    const r = u.data[0];
    try {
      if (owners().length) await mail(owners(), `REFUND REQUEST: ${roomLabel(r)} - ${r.guest_name}`, emailHtml({
        title: 'Caution fee refund requested', lead: 'The guest has checked out and asks for the caution fee back. Inspect the apartment first, then open the secure review link to record the result.',
        rows: [['Reference', r.reference], ['Guest', r.guest_name], ['Phone', r.guest_phone], ['Email', r.guest_email], ['Apartment', roomLabel(r)], ['Check-out', fd(r.check_out)], ['Caution fee', naira(r.caution)], ['Guest message', r.refund_note || '-'], ['Bank details given', r.refund_bank || '-']],
        cta: { label: 'Open refund review', href: adminLink(r.reference) }, note: 'Keep this email private: the button gives access to the refund decision.'
      }));
      await mail(r.guest_email, `We received your refund request - ${r.reference}`, emailHtml({
        title: 'Refund request received', lead: `Hi ${String(r.guest_name).split(' ')[0]}, thank you. Our team will inspect the apartment and update you by email.`,
        rows: [['Reference', r.reference], ['Apartment', roomLabel(r)], ['Caution fee', naira(r.caution)]],
        cta: { label: 'View my receipt', href: `${SITE}/book.html?ref=${r.reference}` }
      }));
    } catch (e) { console.error('refund mail', e.message); }
    json(res, 200, { ok: true });
  } catch (e) {
    console.error('refund-request', e.message);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong. Please call the front desk.' });
  }
};
