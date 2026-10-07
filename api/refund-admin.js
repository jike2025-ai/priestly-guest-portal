const { cors, json, sb, paystack, bad, checkSig, naira, fd, roomLabel, mail, emailHtml, SITE } = require('../lib/core');

// Owner-only (needs the signed link from the refund-request email).
// GET  /api/refund-admin?ref=&sig=                         -> request details
// POST /api/refund-admin {ref,sig,action,amount,method,note} -> record the decision (and refund through Paystack)
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const src = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})) : req.query;
    const ref = String(src.ref || ''), sig = String(src.sig || '');
    if (!/^PA-[A-F0-9]{16}$/.test(ref) || !checkSig(ref, sig)) throw bad('This link is not valid', 403);
    const q = await sb(`bookings?reference=eq.${ref}&select=*`);
    const k = q.data && q.data[0];
    if (!k) throw bad('Booking not found', 404);
    if (req.method === 'GET') {
      return json(res, 200, { booking: { reference: k.reference, name: k.guest_name, phone: k.guest_phone, email: k.guest_email, room: roomLabel(k), checkIn: k.check_in, checkOut: k.check_out, caution: k.caution, total: k.total, channel: k.channel, refundStatus: k.refund_status, requestedAt: k.refund_requested_at, guestNote: k.refund_note, bank: k.refund_bank, refundAmount: k.refund_amount, refundMethod: k.refund_method, adminNote: k.refund_admin_note } });
    }
    if (req.method !== 'POST') throw bad('Method not allowed', 405);
    if (k.refund_status !== 'requested') throw bad('This request was already handled, or none was made', 409);
    const action = src.action, note = String(src.note || '').trim().slice(0, 500), method = src.method === 'manual' ? 'manual' : 'paystack';
    let amount = 0;
    if (action === 'refund') {
      amount = parseInt(src.amount, 10);
      if (!(amount >= 1 && amount <= k.caution)) throw bad('Enter an amount between 1 and the caution fee');
      if (amount < k.caution && !note) throw bad('Please write the reason for the deduction');
    } else if (action === 'decline') {
      if (!note) throw bad('Please write the reason');
    } else throw bad('Unknown action');

    const claim = await sb(`bookings?reference=eq.${ref}&refund_status=eq.requested`, { method: 'PATCH', prefer: 'return=representation', body: { refund_status: 'processing' } });
    if (!claim.data || !claim.data.length) throw bad('This request is already being handled', 409);
    if (action === 'refund' && method === 'paystack') {
      const p = await paystack('/refund', { transaction: ref, amount: amount * 100, currency: 'NGN', merchant_note: 'Caution fee refund ' + ref });
      if (!p.ok) {
        await sb(`bookings?reference=eq.${ref}`, { method: 'PATCH', body: { refund_status: 'requested' } });
        throw bad('Paystack could not process the refund (' + (p.message || 'unknown error') + '). You can refund from the Paystack dashboard and choose "Already paid by bank transfer" here.', 502);
      }
    }
    await sb(`bookings?reference=eq.${ref}`, { method: 'PATCH', body: { refund_status: action === 'refund' ? 'refunded' : 'declined', refund_amount: amount, refund_method: action === 'refund' ? method : null, refund_decided_at: new Date().toISOString(), refund_admin_note: note || null } });

    const first = String(k.guest_name).split(' ')[0], rowsBase = [['Reference', k.reference], ['Apartment', roomLabel(k)], ['Caution fee paid', naira(k.caution)]];
    try {
      const refunded = action === 'refund';
      await mail(k.guest_email, refunded ? `Your caution fee refund - ${k.reference}` : `About your caution fee - ${k.reference}`, emailHtml(refunded ? {
        title: 'Caution fee refund processed',
        lead: `Hi ${first}, thank you for staying with us. We inspected the apartment and your caution fee refund has been processed.` + (method === 'manual' ? ' It was sent to your bank account.' : ' It goes back to your original payment method and can take several working days to show.'),
        rows: rowsBase.concat([['Amount refunded', naira(amount)]], amount < k.caution ? [['Deduction', naira(k.caution - amount)], ['Reason', note]] : [])
      } : {
        title: 'About your caution fee',
        lead: `Hi ${first}, thank you for staying with us. After inspecting the apartment, we are unable to refund the caution fee. Reason: ${note}. Please call the front desk if you would like to discuss this.`,
        rows: rowsBase
      }));
    } catch (e) { console.error('refund guest mail', e.message); }
    json(res, 200, { ok: true, status: action === 'refund' ? 'refunded' : 'declined' });
  } catch (e) {
    console.error('refund-admin', e.message);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
};
