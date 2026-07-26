/* Turns a document or a pasted message into a summary plus proposed facts.
 *
 * Never writes anything. It returns proposals; the client stages them and a
 * human accepts them. The summary and the "also" list exist so you can check
 * the extraction against the original instead of trusting it.
 */

const MODEL = process.env.RUNWAY_MODEL || 'claude-sonnet-5';
const MAX_PROPOSALS = 40;

const SYSTEM = `You read school communications for a parent in Dubai and pull out everything that needs action or belongs on a calendar.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "title": short name for this document, max 6 words,
  "summary": 2-3 sentences on what this document covers, in your own words,
  "also": [up to 6 short strings: things worth knowing that are NOT tasks — policies, rules, limits, contacts],
  "proposals": [ ... ]
}

Each proposal:
{
  "type": "task" | "event" | "rule" | "doc",
  "title": short, sentence case, max 6 words,
  "due": "YYYY-MM-DD", or null if it needs doing but has no fixed date,
  "note": one short sentence of detail, or null,
  "blocking": true only if missing it stops the child attending or enrolling,
  "waiting": true if the school must act before the parent can,
  "match": id of an existing fact this updates, or null,
  "conflict": true if it contradicts an existing fact
}

Rules:
- Be thorough. A registration link, a form, an app to download, a sale, an expo, an opt-in programme are all proposals. Parents miss exactly these.
- Anything that needs doing but carries no date gets "due": null. Do not invent a date.
- A date range gets the start date in "due" and the range in "note".
- Skip greetings, mission statements, staff bios, and curriculum theory.
- Skip anything already in the existing list with the same date.
- If a date is ambiguous between year groups, set conflict true and say so in note.
- Amounts stay in the note, with the currency.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'post only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no api key configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { text, pdf, filename, existing } = body;
    if (!text && !pdf) return res.status(400).json({ error: 'nothing to read' });

    const known = Array.isArray(existing) ? existing.slice(0, 150) : [];
    const content = [];

    if (pdf) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdf }
      });
    }
    content.push({
      type: 'text',
      text:
        'Facts already in the app (do not repeat unless the date changed):\n' +
        JSON.stringify(known) +
        '\n\n' +
        (pdf
          ? 'Read the attached document' + (filename ? ' (' + filename + ')' : '') + '.'
          : 'Read this message:\n\n' + String(text).slice(0, 60000))
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 6000,
        system: SYSTEM,
        messages: [{ role: 'user', content }]
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'model call failed', status: r.status, detail: detail.slice(0, 400) });
    }

    const data = await r.json();
    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    let out;
    try {
      out = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(422).json({ error: 'could not parse model output', raw: raw.slice(0, 400) });
      out = JSON.parse(m[0]);
    }

    const list = Array.isArray(out.proposals) ? out.proposals : [];
    const clean = list.slice(0, MAX_PROPOSALS).map(x => ({
      type: ['task', 'event', 'rule', 'doc'].includes(x.type) ? x.type : 'event',
      title: String(x.title || '').slice(0, 80),
      due: /^\d{4}-\d{2}-\d{2}$/.test(x.due || '') ? x.due : null,
      note: x.note ? String(x.note).slice(0, 200) : null,
      blocking: !!x.blocking,
      waiting: !!x.waiting,
      match: x.match ? String(x.match).slice(0, 40) : null,
      conflict: !!x.conflict
    })).filter(x => x.title);

    return res.json({
      title: String(out.title || filename || 'Pasted message').slice(0, 60),
      summary: String(out.summary || '').slice(0, 600),
      also: (Array.isArray(out.also) ? out.also : []).slice(0, 6).map(s => String(s).slice(0, 160)),
      proposals: clean,
      source: filename || 'pasted text'
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
