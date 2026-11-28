const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the same helpers used by the browser without loading JSX/React.
process.env.TZ = 'Europe/London';
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
const source = html.slice(html.indexOf('    function sleepDayBoundary('), html.indexOf('    function sleepDuration('));
assert.ok(source.includes('function sleepDaySegments'));
const { sleepDayBoundary, sleepDaySegments, sleepTimelineRows, scrollToLoadedTimelineEnd, sleepHistoryEntries } = vm.runInNewContext(source + '\n({ sleepDayBoundary, sleepDaySegments, sleepTimelineRows, scrollToLoadedTimelineEnd, sleepHistoryEntries })');

test('sleep history expands in calendar-week increments', () => {
  const now = new Date(2024, 3, 3, 12);
  const entries = [
    { id: 1, end_time: new Date(2024, 3, 3, 10).toISOString() },
    { id: 2, end_time: new Date(2024, 2, 27, 12).toISOString() },
    { id: 3, end_time: new Date(2024, 2, 25, 10).toISOString() },
    { id: 4, end_time: new Date(2024, 2, 1, 10).toISOString() },
    { id: 5, end_time: new Date(2024, 2, 27, 11, 59).toISOString() },
  ];
  assert.deepEqual(Array.from(sleepHistoryEntries(entries, +now, 7), entry => entry.id), [1, 2]);
  assert.deepEqual(Array.from(sleepHistoryEntries(entries, +now, 14), entry => entry.id), [1, 2, 3, 5]);
  assert.equal(sleepHistoryEntries(entries, +now, 35).length, entries.length);
});

test('timeline loads seven additional older days and scrolls them into view', () => {
  const boundary = sleepDayBoundary(new Date(2024, 3, 3, 12), '07:00');
  const initial = sleepTimelineRows(boundary, '07:00', 7, [], +boundary);
  const expanded = sleepTimelineRows(boundary, '07:00', 14, [], +boundary);
  assert.equal(initial.length, 7);
  assert.equal(expanded.length, 14);
  assert.equal(+expanded[13].from, +sleepDayBoundary(boundary, '07:00', -13));
  assert.match(html, /const \[days, setDays\] = useState\(7\)/);
  assert.match(html, /setDays\(days => days \+ 7\)/);
  assert.match(html, /days > previousTimelineDays\.current\) scrollToLoadedTimelineEnd\(timelineScrollRef\.current\)/);
  assert.match(html, /ref=\{timelineScrollRef\}/);
  const container = { scrollTop: 0, scrollHeight: 980 };
  scrollToLoadedTimelineEnd(container);
  assert.equal(container.scrollTop, 980);
});

test('WASO stays in expanded details and the hatch uses darker indigo shades', () => {
  const summaryStart = html.indexOf('Nap total: ');
  const summaryEnd = html.indexOf('</div>', summaryStart);
  const mainSummary = html.slice(summaryStart, summaryEnd);
  assert.doesNotMatch(mainSummary, /WASO logged/);
  assert.match(html, /WASO logged: \{sleepDuration\(original\.waso\)\}/);
  assert.match(html, /repeating-linear-gradient\(135deg, #4f46e5 0, #4f46e5 3px, #4338ca 3px, #4338ca 6px\)/);
  assert.doesNotMatch(html, /#a5b4fc/);
});

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
