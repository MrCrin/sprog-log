const test = require('node:test');
const assert = require('node:assert/strict');
process.env.TZ = 'Europe/London';
const { nightWindow, classifyEntry, groupNights, clipIntervals, intervalDuration, enabledForDate, rowSummary } = require('../public/sleep-display');
const H = 3600000;
const at = (y, m, d, h, min = 0) => +new Date(y, m - 1, d, h, min);
const entry = (start, end, classification_override = null) => ({ start_time: new Date(start).toISOString(), end_time: end == null ? null : new Date(end).toISOString(), classification_override });

test('classifies by elapsed majority, ties, overrides and changed settings', () => {
  const start = at(2024, 1, 1, 18), end = at(2024, 1, 1, 20);
  assert.equal(classifyEntry(entry(start, end)).type, 'nap');
  assert.equal(classifyEntry(entry(start, end + 1)).type, 'overnight');
  assert.equal(classifyEntry(entry(start, end, 'overnight')).type, 'overnight');
  assert.equal(classifyEntry(entry(start, end, 'nap'), { nap_night_bedtime: '17:00' }).type, 'nap');
  assert.equal(classifyEntry(entry(start, end), { nap_night_bedtime: '17:00', sleep_day_start: '23:00' }).type, 'overnight');
  assert.equal(classifyEntry(entry(start, end), { nap_night_bedtime: '17:00', sleep_day_start: '01:00' }).type, 'overnight');
  assert.equal(classifyEntry(entry(start, end), { nap_night_bedtime: '17:00', nap_night_wake_time: '18:00' }).type, 'nap');
});

test('long entries sum multiple windows and choose greatest overlap', () => {
  const e = entry(at(2024, 1, 1, 20), at(2024, 1, 3, 6));
  const result = classifyEntry(e);
  assert.equal(result.type, 'overnight');
  assert.equal(result.window.date, '2024-01-02'); // equal 11-hour overlaps choose earlier
  assert.equal(classifyEntry(entry(at(2024, 1, 1, 23), at(2024, 1, 3, 7))).window.date, '2024-01-03');
});

test('forced overnight chooses nearest window, earlier on tie', () => {
  const e = entry(at(2024, 1, 2, 12), at(2024, 1, 2, 14), 'overnight');
  assert.equal(classifyEntry(e).window.date, '2024-01-02');
  assert.equal(classifyEntry(entry(at(2024, 1, 2, 15), at(2024, 1, 2, 16), 'overnight')).window.date, '2024-01-03');
});

test('group gaps subtract nap and overlapping sleep without double counting', () => {
  const data = [
    entry(at(2024, 1, 1, 20), at(2024, 1, 1, 22)),
    entry(at(2024, 1, 1, 21), at(2024, 1, 1, 23), 'overnight'),
    entry(at(2024, 1, 2, 1), at(2024, 1, 2, 2), 'nap'),
    entry(at(2024, 1, 2, 1, 30), at(2024, 1, 2, 2, 30), 'nap'),
    entry(at(2024, 1, 2, 4), at(2024, 1, 2, 6)),
  ];
  const group = groupNights(data).nights[0];
  assert.equal(group.date, '2024-01-02');
  assert.equal(group.waso, 3.5 * H);
  assert.deepEqual(group.gaps, [{ start: at(2024, 1, 1, 23), end: at(2024, 1, 2, 1) }, { start: at(2024, 1, 2, 2, 30), end: at(2024, 1, 2, 4) }]);
  assert.equal(intervalDuration(clipIntervals(groupNights(data).naps, at(2024, 1, 2, 0), at(2024, 1, 2, 3))), 1.5 * H);
  assert.equal(groupNights([data[0]]).nights[0].waso, 0);
  assert.deepEqual(groupNights([]).nights, []);
});

test('active entries and clipped gaps use elapsed timestamps', () => {
  const start = at(2024, 1, 1, 22), now = at(2024, 1, 2, 4);
  const group = groupNights([entry(start, null)], {}, now).nights[0];
  assert.equal(group.ongoing, true);
  assert.equal(group.end, now);
  assert.deepEqual(clipIntervals([group], at(2024, 1, 2, 0), now).map(i => [i.start, i.end]), [[at(2024, 1, 2, 0), now]]);
});

test('effective date and row summaries use display day and previous morning', () => {
  const data = [
    entry(at(2024, 1, 1, 20), at(2024, 1, 1, 23)),
    entry(at(2024, 1, 2, 1), at(2024, 1, 2, 6)),
    entry(at(2024, 1, 2, 12), at(2024, 1, 2, 13)),
    entry(at(2024, 1, 2, 14), at(2024, 1, 2, 15))
  ];
  const grouped = groupNights(data);
  const first = new Date(at(2024, 1, 1, 7));
  const second = new Date(at(2024, 1, 2, 7));
  const third = new Date(at(2024, 1, 3, 7));
  const settings = { nap_night_mode: true, nap_night_effective_date: '2024-01-02' };
  assert.equal(enabledForDate(settings, first), false);
  assert.equal(enabledForDate(settings, second), true);
  assert.equal(enabledForDate({ ...settings, nap_night_mode: false }, second), false);
  assert.equal(rowSummary(grouped, first, second).previousNight, null);
  const summary = rowSummary(grouped, second, third);
  assert.equal(summary.napDuration, 2 * H);
  assert.equal(summary.previousNight.date, '2024-01-02');
  assert.equal(summary.previousNight.end - summary.previousNight.start, 10 * H);
  assert.equal(summary.previousNight.waso, 2 * H);
});

test('a long night assigned before cutoff remains visible after the cutoff', () => {
  const grouped = groupNights([entry(at(2024, 1, 1, 19), at(2024, 1, 3, 9), 'overnight')]);
  assert.equal(grouped.nights[0].date, '2024-01-02');
  const summary = rowSummary(grouped, new Date(at(2024, 1, 3, 7)), new Date(at(2024, 1, 4, 7)));
  assert.equal(summary.nights.length, 1);
  assert.equal(summary.nights[0].end - summary.nights[0].start, 2 * H);
});

test('local night windows honor spring and fall DST changes', () => {
  const spring = nightWindow(new Date(2024, 2, 31, 12));
  const fall = nightWindow(new Date(2024, 9, 27, 12));
  assert.equal((spring.end - spring.start) / H, 11);
  assert.equal((fall.end - fall.start) / H, 13);
  assert.equal(classifyEntry(entry(spring.start, spring.end)).window.date, '2024-03-31');
  assert.equal(classifyEntry(entry(fall.start, fall.end)).window.date, '2024-10-27');
});
