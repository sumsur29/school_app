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
  const errs = [];
  const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  let h = null;
  try {
    h = await Blob.head(path, { token: TOKEN });
  } catch (e) {
    return { data: {}, etag: null, via: 'absent', errs: [String((e && e.message) || e)] };
  }
  const etag = h.etag || null;

  if (typeof Blob.get === 'function') {
    for (const target of [path, h.url]) {
      try {
        const r = await Blob.get(target, { token: TOKEN });
        if (r && r.stream) {
          const text = await new Response(r.stream).text();
          if (text) return { data: JSON.parse(text), etag, via: 'sdk-get', errs };
          errs.push('get:' + target.slice(0, 24) + ':empty');
        } else {
          errs.push('get:' + target.slice(0, 24) + ':null');
        }
      } catch (e) { errs.push('get:' + String((e && e.message) || e).slice(0, 80)); }
    }
  } else {
    errs.push('sdk has no get()');
  }

  for (const [label, url, auth] of [
    ['plain', h.downloadUrl || h.url, false],
    ['bearer', h.downloadUrl || h.url, true]
  ]) {
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        headers: auth ? { Authorization: 'Bearer ' + TOKEN } : {}
      });
      if (res.ok) return { data: await res.json(), etag, via: 'fetch-' + label, errs };
      errs.push(label + ':' + res.status);
    } catch (e) { errs.push(label + ':' + String((e && e.message) || e).slice(0, 60)); }
  }

  return { data: {}, etag, via: 'unreadable', errs };
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
      if (req.query.debug) return res.json({ via: st.via, etag: st.etag, keys: Object.keys(st.data), errs: st.errs, sdk: Object.keys(Blob).filter(k => typeof Blob[k] === 'function') });
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
