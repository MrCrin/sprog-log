const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the same helpers used by the browser without loading JSX/React.
process.env.TZ = 'Europe/London';
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
const source = html.slice(html.indexOf('    function sleepDayBoundary('), html.indexOf('    function sleepDuration('));
assert.ok(source.includes('function sleepDaySegments'));
const { sleepDayBoundary, sleepDaySegments } = vm.runInNewContext(source + '\n({ sleepDayBoundary, sleepDaySegments })');

test('local day boundaries account for both DST transitions', () => {
  const spring = sleepDayBoundary(new Date(2024, 2, 30), '07:00');
  const autumn = sleepDayBoundary(new Date(2024, 9, 26), '07:00');
  assert.equal((sleepDayBoundary(spring, '07:00', 1) - spring) / 3600000, 23);
  assert.equal((sleepDayBoundary(autumn, '07:00', 1) - autumn) / 3600000, 25);
});

test('sleep is clipped across day boundaries and active sleep ends at now', () => {
  const day = sleepDayBoundary(new Date(2024, 2, 30), '07:00');
  const next = sleepDayBoundary(day, '07:00', 1);
  const later = sleepDayBoundary(next, '07:00', 1);
  const record = { id: 1, start_time: new Date(+next - 3600000).toISOString(), end_time: null };
  const now = +next + 7200000;
  const first = sleepDaySegments([record], day, next, now);
  const second = sleepDaySegments([record], next, later, now);
  assert.equal(first[0].b - first[0].a, 3600000);
  assert.equal(second[0].b - second[0].a, 7200000);
  assert.equal(sleepDaySegments([record], later, sleepDayBoundary(later, '07:00', 1), now).length, 0);
});
