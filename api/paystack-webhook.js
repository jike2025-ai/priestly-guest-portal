const { confirmBooking } = require('../lib/core');

// Paystack calls this after every successful payment (Dashboard -> Settings -> API Keys & Webhooks).
// We do not trust the request itself: confirmBooking() asks Paystack directly whether the reference was paid.
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.event === 'charge.success' && b.data && /^PA-[A-F0-9]{16}$/.test(b.data.reference || '')) await confirmBooking(b.data.reference);
    res.statusCode = 200; res.end('ok');
  } catch (e) {
    console.error('webhook', e.message);
    res.statusCode = 500; res.end('retry'); // Paystack will try again
  }
};
