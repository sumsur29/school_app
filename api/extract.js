/* Reads a newsletter (by URL or pasted text or uploaded PDF) and returns a
 * summary plus proposed items, filtered to what touches the child.
 *
 * Never writes. The client stages the proposals and a human accepts them.
 */

const MODEL = process.env.RUNWAY_MODEL || 'claude-sonnet-5';
const MAX_PROPOSALS = 40;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const ALLOWED_HOSTS = ['innoventuresedu.static.amais.com', 'diadubai.com', 'www.diadubai.com',
  'innoventureseducation-my.sharepoint.com', 'innoventureseducation.sharepoint.com'];

function system(yg, childName, todayIso) {
  return `Today is ${todayIso}. The academic year runs 31 Aug 2026 to 2 Jul 2027, so any date without a year falls in that window — never earlier.

You read a primary-school newsletter for the parents of ${childName || 'a child'} in ${yg} at DIA Emirates Hills, Dubai.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "title": short name for this document, max 7 words (e.g. "Newsletter Issue 7, 23 Oct", "Book fair envelope"),
  "docKind": "Newsletter" | "Class sheet" | "Letter" | "Message" | "Other",
  "issued": "YYYY-MM-DD" date of the document if stated, else null,
  "summary": 2-3 sentences on what matters to a ${yg} family in this issue,
  "also": [up to 6 short strings: things worth knowing that are not tasks — reminders, rules, policy changes],
  "proposals": [ ... ]
}

Each proposal:
{
  "kind": "pay" | "do" | "wear" | "event" | "off" | "info",
  "title": short, sentence case, max 7 words,
  "due": "YYYY-MM-DD" or null if it needs doing but has no fixed date,
  "until": "YYYY-MM-DD" if it runs across several days, else null,
  "time": "HH:MM" 24h start time if the item has one, else null,
  "endTime": "HH:MM" if an end time is given, else null,
  "note": one sentence of detail — amount, where, what to wear, what to bring,
  "bring": what physically has to go in the bag or on the child that day (e.g. "something red", "envelope with AED 50"), or null,
  "blocking": true for any payment deadline, and for a dated task the parents must deliver by that date (photos, forms, money in an envelope),
  "match": id of an existing item this updates, or null,
  "conflict": true if it contradicts an existing item
}

Rules — read these carefully, they are the whole job:
- Include anything for ${yg}, for KG generally, for "KG1-Y6", for "all primary", for "PS", or for parents and families generally.
- EXCLUDE anything only for other year groups: Y1, Y2, Y3, Y4, Y5, Y6, KG2 (unless ${yg} is KG2), camps, CAT4, NGRT, PASS, residentials, Sri Lanka, exhibitions by a named other year.
- kind: "pay" = money due; "do" = something the parents must send, fill, email or make; "wear" = dress-up or bring-something day; "event" = something happening; "off" = no school, break, early finish, changed timings; "info" = worth knowing, nothing to act on.
- Payment deadlines are the single most important thing. Zenda payments, cash in an envelope, anything with an amount and a date: kind "pay", blocking true, amount in the note, and "bring" if it travels in the bag.
- Things parents must deliver — photos to the teacher, a video, a form — are kind "do", blocking true, with the due date.
- Early dismissal, no-school days, breaks, PTCs, changed timings: kind "off", always include. Put the new time in "time".
- "Wear X" or "bring X" days: kind "wear", put the thing in "bring".
- A single email about one thing usually yields one or two items. That is correct. Do not pad.
- Photo days, concerts, picnics, fairs, performances for ${yg}: include with times if given.
- A PADIA sale, souq, coffee morning or community event: include.
- An external competition or opportunity (spelling bee, olympiad, fitness challenge): include once as an event with "optional" in the note.
- Do not repeat anything already in the existing list with the same date unless the time or detail changed — then set match to its id.
- If the newsletter calendar says one thing and the body text says another, trust the body text and set conflict true.
- Prefer accuracy over volume. Twelve correct items beat thirty noisy ones.
- "next Thursday", "tomorrow", "this Friday" are relative to today's date above. Resolve them to a real date in the academic year.`;
}

async function fetchPdf(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('not a valid link'); }
  if (u.protocol !== 'https:') throw new Error('link must be https');
  if (!ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)))
    throw new Error('that site is not on the list — paste the text instead, or upload the PDF');
  const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Runway/1.0' }, redirect: 'follow' });
  if (!r.ok) throw new Error('could not download it (' + r.status + ')');
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_PDF_BYTES) throw new Error('that file is too big');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error('that file is too big');
  if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('that link is not a PDF');
  return buf.toString('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'post only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no api key configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { text, url, filename, existing, yg, childName, image, imageType } = body;
    let pdf = body.pdf || null;
    let sourceName = filename || null;

    if (url && !pdf && !text) {
      pdf = await fetchPdf(url);
      try { sourceName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'newsletter.pdf'); } catch (e) { sourceName = 'newsletter.pdf'; }
    }
    if (!text && !pdf && !image) return res.status(400).json({ error: 'nothing to read' });

    const known = Array.isArray(existing) ? existing.slice(0, 200) : [];
    const content = [];
    if (pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } });
    if (image) {
      const mt = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(imageType) ? imageType : 'image/jpeg';
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: image } });
    }
    content.push({
      type: 'text',
      text: 'Items already in the app (skip unless changed):\n' + JSON.stringify(known) + '\n\n' +
        ((pdf || image) ? 'Read the attached document' + (sourceName ? ' (' + sourceName + ')' : '') + '.'
             : 'Read this message:\n\n' + String(text).slice(0, 60000))
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: system(yg || 'KG1', childName, new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10)), messages: [{ role: 'user', content }] })
    });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'model call failed', status: r.status, detail: detail.slice(0, 400) });
    }

    const data = await r.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
      .replace(/```json|```/g, '').trim();
    let out;
    try { out = JSON.parse(raw); }
    catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(422).json({ error: 'could not parse model output', raw: raw.slice(0, 400) });
      out = JSON.parse(m[0]);
    }

    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    const fixYear = s => {
      if (!isDate(s)) return null;
      const d = new Date(s + 'T00:00:00Z'), now = Date.now();
      if (d.getTime() < now - 60 * 864e5) { d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); }
      if (d.getTime() > now + 400 * 864e5) { d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10); }
      return s;
    };
    const isTime = s => /^\d{2}:\d{2}$/.test(s || '');
    const list = Array.isArray(out.proposals) ? out.proposals : [];
    const clean = list.slice(0, MAX_PROPOSALS).map(x => ({
      kind: ['pay', 'do', 'wear', 'event', 'off', 'info'].includes(x.kind) ? x.kind : 'event',
      title: String(x.title || '').slice(0, 80),
      due: fixYear(x.due),
      until: fixYear(x.until),
      time: isTime(x.time) ? x.time : null,
      endTime: isTime(x.endTime) ? x.endTime : null,
      note: x.note ? String(x.note).slice(0, 200) : null,
      bring: x.bring ? String(x.bring).slice(0, 80) : null,
      blocking: !!x.blocking,
      match: x.match ? String(x.match).slice(0, 40) : null,
      conflict: !!x.conflict
    })).filter(x => x.title);

    return res.json({
      title: String(out.title || sourceName || 'Pasted message').slice(0, 60),
      docKind: ['Newsletter', 'Class sheet', 'Letter', 'Message', 'Other'].includes(out.docKind) ? out.docKind : (pdf ? 'Newsletter' : image ? 'Class sheet' : 'Message'),
      issued: isDate(out.issued) ? out.issued : null,
      summary: String(out.summary || '').slice(0, 600),
      also: (Array.isArray(out.also) ? out.also : []).slice(0, 6).map(s => String(s).slice(0, 160)),
      proposals: clean,
      source: sourceName || 'pasted text',
      url: url || null
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
