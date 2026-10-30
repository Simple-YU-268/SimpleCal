import { refreshLunarRdates } from './ical.mjs';

/** Existing SimpleCal export format shared by the HTTP and DAV adapters. */
export function mergeCalendars(objects) {
  const timezones = new Map();
  const blocks = [];
  for (const object of objects) {
    const content = refreshLunarRdates(String(object.content || ''));
    for (const match of content.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/g) || []) {
      const tzid = (/^TZID:(.*)$/m.exec(match) || [])[1];
      if (tzid && !timezones.has(tzid.trim())) timezones.set(tzid.trim(), match.replace(/\s+$/, ''));
    }
    const inner = content
      .replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r?\n?/g, '')
      .split(/\r?\n/)
      .filter((line) => !/^BEGIN:VCALENDAR\s*$/i.test(line)
        && !/^END:VCALENDAR\s*$/i.test(line)
        && !/^VERSION:/i.test(line)
        && !/^PRODID:/i.test(line)
        && !/^CALSCALE:/i.test(line))
      .join('\r\n').trim();
    if (inner) blocks.push(inner);
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SimpleCal//EXPORT//EN',
    'CALSCALE:GREGORIAN', ...timezones.values(), ...blocks, 'END:VCALENDAR', ''].join('\r\n');
}
