// Presentation-only sleep classification. All arithmetic is in elapsed milliseconds;
// recurring windows are constructed using local calendar dates, including DST changes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SleepDisplay = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function localDate(value) {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function timeParts(value, fallback) {
    const match = /^(\d{2}):(\d{2})$/.exec(value || '');
    if (!match || +match[1] > 23 || +match[2] > 59) return fallback;
    return [+match[1], +match[2]];
  }

  // The date identifies the local calendar date on which the window ends.
  function nightWindow(date, settings = {}) {
    const d = new Date(date);
    const bed = timeParts(settings.nap_night_bedtime, [19, 0]);
    const wake = timeParts(settings.nap_night_wake_time, [7, 0]);
    const overnight = bed[0] * 60 + bed[1] >= wake[0] * 60 + wake[1];
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (overnight ? 1 : 0), bed[0], bed[1]);
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), wake[0], wake[1]);
    return { date: localDate(d), start: +start, end: +end };
  }

  function windowsNear(start, end, settings) {
    const first = new Date(start);
    const last = new Date(end);
    const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 2, 12);
    const limit = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 2, 12);
    const result = [];
    while (cursor <= limit) {
      result.push(nightWindow(cursor, settings));
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }

  function classifyEntry(entry, settings = {}, now = Date.now()) {
    const start = new Date(entry.start_time).getTime();
    const ongoing = entry.end_time == null;
    const end = ongoing ? +new Date(now) : new Date(entry.end_time).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const windows = windowsNear(start, end, settings);
    let total = 0;
    let best = null;
    let bestOverlap = 0;
    for (const window of windows) {
      const overlap = Math.max(0, Math.min(end, window.end) - Math.max(start, window.start));
      total += overlap;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = window;
      }
    }
    const override = entry.classification_override;
    const type = override === 'nap' || override === 'overnight'
      ? override : (total > (end - start) / 2 ? 'overnight' : 'nap');
    if (type === 'overnight' && !best) {
      let distance = Infinity;
      for (const window of windows) {
        const candidate = Math.max(window.start - end, start - window.end, 0);
        if (candidate < distance) {
          best = window;
          distance = candidate;
        }
      }
    }
    return { entry, type, start, end, ongoing, window: type === 'overnight' ? best : null };
  }

  function clipIntervals(intervals, from, to) {
    const a = +new Date(from), b = +new Date(to);
    return intervals.map(interval => ({ ...interval, start: Math.max(a, interval.start), end: Math.min(b, interval.end) }))
      .filter(interval => interval.end > interval.start);
  }

  function mergeIntervals(intervals) {
    const sorted = intervals.filter(i => i.end > i.start).map(i => ({ start: i.start, end: i.end }))
      .sort ( (a, b) => a.start - b.start || a.end - b.end );
    const merged = [];
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
      else merged.push(interval);
    }
    return merged;
  }

  function intervalDuration(intervals) {
    return mergeIntervals(intervals).reduce((sum, i) => sum + i.end - i.start, 0);
  }

  function groupNights(entries, settings = {}, now = Date.now()) {
    const classified = entries.map(entry => classifyEntry(entry, settings, now)).filter(Boolean);
    const naps = classified.filter(entry => entry.type === 'nap');
    const byDate = new Map();
    for (const entry of classified) {
      if (entry.type !== 'overnight') continue;
      const date = entry.window.date;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    }
    const nights = Array.from(byDate, ([date, members]) => {
      members.sort((a, b) => a.start - b.start || a.end - b.end);
      const start = members[0].start;
      const end = Math.max(...members.map(i => i.end));
      // Subtract every logged sleep, including naps and entries assigned to a
      // different night, from the span. Overlaps must not be counted twice.
      const covered = mergeIntervals(clipIntervals(classified, start, end));
      const gaps = [];
      let cursor = start;
      for (const interval of covered) {
        if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start });
        cursor = Math.max(cursor, interval.end);
      }
      if (cursor < end) gaps.push({ start: cursor, end });
      return { date, window: members[0].window, start, end, ongoing: members.some(i => i.ongoing), entries: members, gaps, waso: intervalDuration(gaps) };
    }).sort((a, b) => a.date.localeCompare(b.date));
    return { entries: classified, naps, nights };
  }

  // Row dates are local display-day labels. A night is attributed to the date
  // its configured window ends, even when most of its bar is on an earlier row.
  function enabledForDate(settings, date) {
    return settings.nap_night_mode === true && !!settings.nap_night_effective_date && localDate(date) >= settings.nap_night_effective_date;
  }

  function rowSummary(grouped, from, to) {
    const date = localDate(from);
    const naps = clipIntervals(grouped.naps, from, to);
    const nights = clipIntervals(grouped.nights, from, to);
    const previousNight = grouped.nights.find(night => night.date === date) || null;
    return { naps, nights, previousNight, napDuration: intervalDuration(naps) };
  }

  return { localDate, nightWindow, classifyEntry, groupNights, clipIntervals, mergeIntervals, intervalDuration, enabledForDate, rowSummary };
});
