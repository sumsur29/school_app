/* Shared family state.
   One flat map of keys -> { ...value, at }. Merge is per key, newest wins.
   Never write the whole blob from the client — that's how one phone
   silently erases the other's changes. */

const U = process.env.KV_REST_API_URL;
const T = process.env.KV_REST_API_TOKEN;

async function kv(path, init) {
  const r = await fetch(`${U}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${T}`, ...(init && init.headers) }
  });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  if (!U || !T) return res.status(500).json({ error: 'storage not configured' });

  const fam = String(req.query.f || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  if (!fam) return res.status(400).json({ error: 'no family id' });

  const key = `runway:${fam}`;

  try {
    const { result } = await kv(`get/${encodeURIComponent(key)}`);
    const cur = result ? JSON.parse(result) : {};

    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(cur);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      let changed = 0;
      for (const [k, v] of Object.entries(body)) {
        if (!v || typeof v !== 'object') continue;
        const incoming = Number(v.at) || 0;
        const existing = Number(cur[k] && cur[k].at) || 0;
        if (incoming > existing) { cur[k] = v; changed++; }
      }
      if (changed) {
        await kv(`set/${encodeURIComponent(key)}`, {
          method: 'POST',
          body: JSON.stringify(cur)
        });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json(cur);
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
