/* Subscribable calendar feed, one per family.
 *
 * Google Calendar and Apple Calendar both accept a URL to an .ics file and
 * re-fetch it on their own schedule. Subscribe once on each phone, and every
 * item the family keeps shows up on both calendars with no further taps.
 *
 * Seed items live in index.html, not here, so this reads them from the
 * same blob the app writes to — the client mirrors the seed list in under
 * the 'seedcal' key on every render so the feed stays in sync.
 */

import * as Blob from '@vercel/blob';

const TZ = 'Asia/Dubai';

async function readFam(fam) {
  const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  const path = `runway/${fam}.json`;
  try {
    const h = await Blob.head(path, { token: TOKEN });
    const r = await Blob.get(path, { token: TOKEN, access: 'private' });
    if (r && r.stream) return JSON.parse(await new Response(r.stream).text() || '{}');
    const res = await fetch(h.downloadUrl || h.url, { headers: { Authorization: 'Bearer ' + TOKEN }, cache: 'no-store' });
    return res.ok ? await res.json() : {};
  } catch (e) { return {}; }
}

const pad = n => String(n).padStart(2, '0');
const icsDate = s => s.replace(/-/g, '');
const icsStamp = () => {
  const d = new Date();
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
};
const esc = s => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = line => {
  const out = [];
  let s = line;
  while (s.length > 72) { out.push(s.slice(0, 72)); s = ' ' + s.slice(72); }
  out.push(s);
  return out.join('\r\n');
};

function nextDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function event(it, fam) {
  const uid = `${it.id}@runway.${fam}`;
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsStamp()}`];

  if (it.time && /^\d{2}:\d{2}$/.test(it.time)) {
    const [h, m] = it.time.split(':');
    const end = it.endTime && /^\d{2}:\d{2}$/.test(it.endTime) ? it.endTime.split(':') : [String(+h + 1).padStart(2, '0'), m];
    lines.push(`DTSTART;TZID=${TZ}:${icsDate(it.due)}T${h}${m}00`);
    lines.push(`DTEND;TZID=${TZ}:${icsDate(it.due)}T${end[0]}${end[1]}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(it.due)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(it.until ? nextDay(it.until) : nextDay(it.due))}`);
  }

  const prefix = it.blocking ? '⚠ ' : '';
  lines.push(fold(`SUMMARY:${esc(prefix + it.title)}`));
  const desc = [it.note, it.status && it.status !== 'open' ? `Status: ${it.status}${it.by ? ' (' + it.by + ')' : ''}` : '', 'From Runway']
    .filter(Boolean).join('\n');
  lines.push(fold(`DESCRIPTION:${esc(desc)}`));
  if (it.blocking) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(it.title)} tomorrow`, 'TRIGGER:-P1D', 'END:VALARM');
  } else if (it.time) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(it.title)}`, 'TRIGGER:-PT30M', 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

export default async function handler(req, res) {
  const fam = String(req.query.f || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  if (!fam) return res.status(400).send('no family id');
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).send('storage not connected');

  const L = await readFam(fam);
  const hidden = new Set(Object.keys(L).filter(k => k.startsWith('hide:') && L[k] && L[k].v).map(k => k.slice(5)));
  const stateOf = id => (L['fact:' + id] || {});
  const nameOf = id => ((L['member:' + id] || {}).name) || '';

  const seed = Array.isArray((L.seedcal || {}).items) ? L.seedcal.items : [];
  const custom = Object.keys(L).filter(k => k.startsWith('cf:'))
    .map(k => Object.assign({}, L[k], { id: k.slice(3) }))
    .filter(f => !f.deleted && f.title && f.due);

  const items = seed.filter(f => !hidden.has(f.id)).concat(custom)
    .filter(f => f.due && /^\d{4}-\d{2}-\d{2}$/.test(f.due))
    .map(f => {
      const s = stateOf(f.id);
      return Object.assign({}, f, { status: s.status, by: s.by ? nameOf(s.by) : '' });
    })
    .filter(f => f.status !== 'done' || f.time);

  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Runway//DIA//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${esc('Runway · ' + (seed.length ? 'KG1' : 'school'))}`),
    `X-WR-TIMEZONE:${TZ}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VTIMEZONE', `TZID:${TZ}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0400', 'TZOFFSETTO:+0400', 'TZNAME:GST', 'END:STANDARD', 'END:VTIMEZONE',
    ...items.map(it => event(it, fam)),
    'END:VCALENDAR'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="runway.ics"');
  res.setHeader('Cache-Control', 'public, max-age=900');
  return res.status(200).send(body);
}
