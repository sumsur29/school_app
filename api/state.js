/* Shared family state, stored as one JSON blob per family.
 *
 * Shape: { "<key>": { ...value, at: <epoch ms> } }
 * Merge is per key, newest `at` wins. The client only ever sends the keys
 * it changed — never the whole map — so two phones editing different
 * things can't overwrite each other.
 *
 * Writes use ifMatch on the blob's ETag. If the other phone wrote while we
 * were merging, the put fails, we re-read and try again. That closes the
 * read-modify-write race properly rather than hoping it never happens.
 */

import * as Blob from '@vercel/blob';

const pathFor = fam => `runway/${fam}.json`;
const MAX_TRIES = 4;

async function readState(path) {
  if (typeof Blob.get === 'function') {
    try {
      const r = await Blob.get(path);
      if (!r) return { data: {}, etag: null };
      const text = await new Response(r.stream).text();
      return { data: JSON.parse(text || '{}'), etag: (r.blob && r.blob.etag) || null };
    } catch (e) {
      if (e && /not.?found/i.test(String(e.name || e.message))) return { data: {}, etag: null };
    }
  }
  try {
    const h = await Blob.head(path);
    const res = await fetch(h.url, { cache: 'no-store' });
    if (!res.ok) return { data: {}, etag: h.etag || null };
    return { data: await res.json(), etag: h.etag || null };
  } catch (e) {
    return { data: {}, etag: null };
  }
}

function writeState(path, data, etag) {
  const opts = {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0
  };
  if (etag) opts.ifMatch = etag;
  return Blob.put(path, JSON.stringify(data), opts);
}

const isPreconditionFail = e =>
  (Blob.BlobPreconditionFailedError && e instanceof Blob.BlobPreconditionFailedError) ||
  /precondition/i.test(String((e && e.name) || (e && e.message) || ''));

export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    return res.status(500).json({ error: 'blob store not connected' });

  const fam = String(req.query.f || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  if (!fam) return res.status(400).json({ error: 'no family id' });

  const path = pathFor(fam);
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const { data } = await readState(path);
      return res.json(data);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : (req.body || {});

      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        const { data, etag } = await readState(path);

        let changed = 0;
        for (const k of Object.keys(body)) {
          const v = body[k];
          if (!v || typeof v !== 'object') continue;
          const incoming = Number(v.at) || 0;
          const existing = Number(data[k] && data[k].at) || 0;
          if (incoming > existing) { data[k] = v; changed++; }
        }

        if (!changed) return res.json(data);

        try {
          await writeState(path, data, etag);
          return res.json(data);
        } catch (e) {
          if (isPreconditionFail(e) && attempt < MAX_TRIES - 1) continue;
          throw e;
        }
      }
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
