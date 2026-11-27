const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'America/New_York';
const source = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
const helpers = source.slice(source.indexOf('function sleepDayBoundary'), source.indexOf('function sleepDuration'));
const context = vm.createContext({});
vm.runInContext(helpers + '\nthis.boundary = sleepDayBoundary; this.segments = sleepDaySegments;', context);

test('local sleep day boundaries respect spring and autumn clock changes', () => {
  const spring = context.boundary(new Date(2024, 2, 9, 7), '07:00');
  const springEnd = context.boundary(spring, '07:00', 1);
  const autumn = context.boundary(new Date(2024, 10, 2, 7), '07:00');
  const autumnEnd = context.boundary(autumn, '07:00', 1);
  assert.equal((springEnd - spring) / 3600000, 23);
  assert.equal((autumnEnd - autumn) / 3600000, 25);
});

test('cross-boundary and active intervals are clipped to each day', () => {
  const from = context.boundary(new Date(2024, 2, 9, 7), '07:00');
  const to = context.boundary(from, '07:00', 1);
  const records = [{ id: 1, start_time: new Date(+from - 3600000).toISOString(), end_time: new Date(+to + 3600000).toISOString() }];
  const segments = context.segments(records, from, to, +to);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].a, +from);
  assert.equal(segments[0].b, +to);
  const active = context.segments([{ id: 2, start_time: from.toISOString(), end_time: null }], from, to, +from + 3600000);
  assert.equal(active[0].b, +from + 3600000);
});
