// /api/wifi-voucher-sync
// Called ONLY by the MikroTik router (every 5 minutes), never by guests or staff.
// Auth: header  X-Sync-Key: <ROUTER_SYNC_KEY>
//
//   GET  ?action=status            -> { need, unused, expired: [usernames] }
//   POST { action:"add", vouchers:[{u,p},...] }   -> new vouchers go into the pool
//   POST { action:"confirm", expired:[usernames] } -> router removed them, mark expired

const { supa, safeEqual, cors, readBody } = require('../lib/wifi');

const ID = /^[A-Za-z0-9]{4,32}$/;

module.exports = async (req, res) => {
  cors(req, res);

  if (!process.env.ROUTER_SYNC_KEY) return res.status(500).json({ error: 'ROUTER_SYNC_KEY is not set on the server' });
  if (!safeEqual(req.headers['x-sync-key'], process.env.ROUTER_SYNC_KEY)) { await new Promise((r) => setTimeout(r, 1000)); return res.status(401).json({ error: 'Not allowed' }); } // delay slows key guessing

  try {
    if (req.method === 'GET') {
      if ((req.query && req.query.action) !== 'status') return res.status(400).json({ error: 'Unknown action' });

      const target = Math.max(0, Math.min(200, Number(process.env.WIFI_POOL_TARGET || 20)));

      const c = await supa('wifi_vouchers?select=id&status=eq.unused&limit=1', { headers: { Prefer: 'count=exact' } });
      const total = parseInt(String(c.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0;

      const now = encodeURIComponent(new Date().toISOString());
      const e = await supa('wifi_vouchers?select=username&status=eq.assigned&expires_at=lt.' + now + '&order=expires_at&limit=50');
      const expired = (e.data || []).map((r) => r.username);

      return res.status(200).json({ need: Math.max(0, target - total), unused: total, expired });
    }

    if (req.method === 'POST') {
      const b = readBody(req);

      if (b.action === 'add') {
        const list = Array.isArray(b.vouchers) ? b.vouchers.slice(0, 50) : [];
        const rows = [];
        for (const v of list) {
          const u = String((v && v.u) || '');
          const p = String((v && v.p) || '');
          if (ID.test(u) && ID.test(p)) rows.push({ username: u, password: p });
        }
        if (!rows.length) return res.status(400).json({ error: 'No valid vouchers sent' });

        await supa('wifi_vouchers?on_conflict=username', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: rows,
        });
        return res.status(200).json({ added: rows.length });
      }

      if (b.action === 'confirm') {
        const names = (Array.isArray(b.expired) ? b.expired : []).map(String).filter((u) => ID.test(u)).slice(0, 100);
        if (names.length) {
          await supa('wifi_vouchers?status=eq.assigned&username=in.(' + names.map(encodeURIComponent).join(',') + ')', {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: { status: 'expired' },
          });
        }
        return res.status(200).json({ confirmed: names.length });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Use GET or POST' });
  } catch (e) {
    console.error('wifi-voucher-sync', e && e.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
