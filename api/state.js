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
  let h = null;
  try {
    h = await Blob.head(path);
  } catch (e) {
    return { data: {}, etag: null, via: 'absent' };
  }
  const etag = h.etag || null;

  if (typeof Blob.get === 'function') {
    for (const target of [h.url, path]) {
      try {
        const r = await Blob.get(target);
        if (r && r.stream) {
          const text = await new Response(r.stream).text();
          if (text) return { data: JSON.parse(text), etag: etag, via: 'sdk-get' };
        }
      } catch (e) {}
    }
  }

  try {
    const res = await fetch(h.downloadUrl || h.url, { cache: 'no-store' });
    if (res.ok) return { data: await res.json(), etag: etag, via: 'fetch' };
  } catch (e) {}

  return { data: {}, etag: etag, via: 'unreadable' };
}

function writeState(path, data, etag, access) {
  const opts = {
    access: access || 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0
  };
  if (etag) opts.ifMatch = etag;
  return Blob.put(path, JSON.stringify(data), opts);
}

async function writeEither(path, data, etag) {
  try {
    return await writeState(path, data, etag, 'private');
  } catch (e) {
    if (/access|public|private/i.test(String((e && e.message) || '')))
      return writeState(path, data, etag, 'public');
    throw e;
  }
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
      const st = await readState(path);
      if (req.query.debug) return res.json({ via: st.via, etag: st.etag, keys: Object.keys(st.data) });
      return res.json(st.data);
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
          await writeEither(path, data, etag);
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
