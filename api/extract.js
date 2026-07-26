/* Turns a document or a pasted message into proposed facts.
 *
 * Never writes anything. It returns proposals; the client stages them in the
 * shared inbox and a human accepts them. That boundary is the whole design —
 * a model should not be able to move a fee deadline on its own.
 */

const MODEL = process.env.RUNWAY_MODEL || 'claude-sonnet-5';
const MAX_PROPOSALS = 40;

const SYSTEM = `You read school communications for a parent in Dubai and pull out only the things that need action or appear on a calendar.

Return ONLY a JSON array. No prose, no markdown fences.

Each element:
{
  "type": "task" | "event" | "rule" | "doc",
  "title": short, sentence case, max 6 words,
  "due": "YYYY-MM-DD" or null,
  "note": one short sentence of detail, or null,
  "blocking": true only if missing it stops the child attending or enrolling,
  "waiting": true if the school must act before the parent can,
  "match": id of an existing fact this updates, or null,
  "conflict": true if it contradicts an existing fact
}

Rules:
- A date range gets the start date in "due" and the range in "note".
- Skip greetings, mission statements, staff bios, and anything with no date or action.
- Skip anything already in the existing list with the same date.
- If a date is ambiguous between year groups, set conflict true and say so in note.
- Prefer fewer, higher-quality items. Ten good ones beat forty noisy ones.
- Amounts stay in the note, with the currency.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'post only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no api key configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { text, pdf, filename, existing } = body;
    if (!text && !pdf) return res.status(400).json({ error: 'nothing to read' });

    const known = Array.isArray(existing) ? existing.slice(0, 120) : [];
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
        'Existing facts already in the app (do not repeat these unless the date changed):\n' +
        JSON.stringify(known) +
        '\n\n' +
        (pdf
          ? 'Extract from the attached document' + (filename ? ' (' + filename + ')' : '') + '.'
          : 'Extract from this message:\n\n' + String(text).slice(0, 60000))
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
        max_tokens: 4000,
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

    let list;
    try {
      list = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/\[[\s\S]*\]/);
      if (!m) return res.status(422).json({ error: 'could not parse model output', raw: raw.slice(0, 400) });
      list = JSON.parse(m[0]);
    }
    if (!Array.isArray(list)) return res.status(422).json({ error: 'expected an array' });

    const clean = list.slice(0, MAX_PROPOSALS).map(x => ({
      type: ['task', 'event', 'rule', 'doc'].includes(x.type) ? x.type : 'event',
      title: String(x.title || '').slice(0, 80),
      due: /^\d{4}-\d{2}-\d{2}$/.test(x.due || '') ? x.due : null,
      note: x.note ? String(x.note).slice(0, 160) : null,
      blocking: !!x.blocking,
      waiting: !!x.waiting,
      match: x.match ? String(x.match).slice(0, 40) : null,
      conflict: !!x.conflict
    })).filter(x => x.title);

    return res.json({ proposals: clean, source: filename || 'pasted text' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
