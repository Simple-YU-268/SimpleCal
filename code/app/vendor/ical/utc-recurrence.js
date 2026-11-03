// Shared by the server and browser. Floating series keep local arithmetic.
export function utcPeriodStarts(rule, start, period) {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const day = start.getUTCDate();
  const weekday = start.getUTCDay();
  const make = (year, month, date) => new Date(Date.UTC(year, month, date,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  const hop = period * rule.interval;
  if (rule.freq === 'daily') return [make(y, m, day + hop)];
  if (rule.freq === 'weekly') {
    const wkst = rule.wkst || 0;
    const offset = (weekday - wkst + 7) % 7;
    return [...rule.byWeekday].sort((a, b) => (a - wkst + 7) % 7 - (b - wkst + 7) % 7)
      .map((wd) => make(y, m, day + hop * 7 + (wd - wkst + 7) % 7 - offset))
      .filter((date) => date >= start);
  }
  const month = rule.freq === 'monthly' ? m + hop : m;
  const year = rule.freq === 'yearly' ? y + hop : y;
  const last = new Date(Date.UTC(year, month + 1, 0));
  let date = day;
  if (rule.freq === 'monthly' && rule.monthlyMode === 'weekday') {
    const nth = rule.monthlyNth ?? Math.ceil(day / 7);
    date = nth === -1
      ? last.getUTCDate() - (last.getUTCDay() - weekday + 7) % 7
      : 1 + (weekday - new Date(Date.UTC(year, month, 1)).getUTCDay() + 7) % 7 + (nth - 1) * 7;
  }
  if (date > last.getUTCDate()) return [];
  const candidate = make(year, month, date);
  return candidate >= start ? [candidate] : [];
}

export function utcPeriodIndex(rule, start, targetMs) {
  const target = new Date(targetMs);
  if (rule.freq === 'monthly') return Math.floor(((target.getUTCFullYear() - start.getUTCFullYear()) * 12
    + target.getUTCMonth() - start.getUTCMonth()) / rule.interval);
  if (rule.freq === 'yearly') return Math.floor((target.getUTCFullYear() - start.getUTCFullYear()) / rule.interval);
  const midnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const anchor = rule.freq === 'weekly' ? midnight - (start.getUTCDay() - (rule.wkst || 0) + 7) % 7 * 86400000 : midnight;
  return Math.floor((targetMs - anchor) / 86400000 / rule.interval / (rule.freq === 'weekly' ? 7 : 1));
}
