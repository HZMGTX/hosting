// Minimal 5-field cron parser: "min hour day-of-month month day-of-week".
// Supports *, numbers, lists (1,5), ranges (1-5), steps (*/15, 0-30/5) and @hourly/@daily/@weekly/@monthly.
const PRESETS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *'
};
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 }
];

function parseField(expr, { min, max, name }) {
  const values = new Set();
  for (const part of expr.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`Invalid ${name} "${part}"`);
    let lo = min, hi = max;
    if (m[2] !== undefined) { lo = parseInt(m[2], 10); hi = m[3] !== undefined ? parseInt(m[3], 10) : (m[4] ? max : lo); }
    const step = m[4] ? parseInt(m[4], 10) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`${name} out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function parse(expression) {
  const expr = PRESETS[String(expression).trim()] || String(expression).trim();
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression needs 5 fields: minute hour day month weekday');
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

function matches(parsed, date) {
  const [min, hour, dom, mon, dow] = parsed.sets;
  if (!min.has(date.getMinutes()) || !hour.has(date.getHours()) || !mon.has(date.getMonth() + 1)) return false;
  const domOk = dom.has(date.getDate());
  const dowOk = dow.has(date.getDay());
  // Standard cron: if both day fields are restricted, either may match.
  if (!parsed.domStar && !parsed.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

function nextRun(expression, from = new Date()) {
  const parsed = parse(expression);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(parsed, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function validate(expression) {
  try { parse(expression); return null; } catch (e) { return e.message; }
}

module.exports = { parse, matches, nextRun, validate };
