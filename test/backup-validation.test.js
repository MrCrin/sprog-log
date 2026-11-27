const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Load the production validators without starting the server or requiring a DB.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const milestone = source.slice(source.indexOf('const MILESTONE_ICON_KEYS'), source.indexOf('// 2.5 PIN AUTH'));
const backup = source.slice(source.indexOf('const BACKUP_SECTIONS'), source.indexOf("app.get('/api/backup'"));
const context = vm.createContext({});
vm.runInContext(milestone + '\n' + backup + '\nthis.validate = validateBackup;', context);
const validate = context.validate;

const sleep = (start, end) => ({ start_time: start, end_time: end });

test('validates versioned and both legacy weight formats', () => {
  assert.equal(validate({ version: 1, entries: [{ date: '2024-02-29', weight: 5000 }] }).entries[0].weight, 5000);
  assert.equal(validate({ birthDate: '2023-01-01', entries: [{ date: '2024-01-02T00:00:00.000Z', weight: '6000' }] }).entries[0].weight, 6000);
  assert.equal(Object.hasOwn(validate({ profile: null, entries: [] }), 'profile'), false);
  assert.equal(Object.hasOwn(validate({ profile: { name: 'Child' }, entries: [] }), 'profile'), false);
  assert.equal(validate({ version: 1, profile: null }).profile, null);
  assert.throws(() => validate({ version: 2, entries: [] }), /version/);
  assert.throws(() => validate({ entries: [{ date: '2023-02-29', weight: 5000 }] }), /weight/);
});

test('rejects invalid, overlapping, active and future sleep entries', () => {
  const one = sleep('2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z');
  const two = sleep('2024-01-01T00:30:00Z', '2024-01-01T02:00:00Z');
  assert.equal(validate({ version: 1, sleep: [one] }).sleep.length, 1);
  assert.equal(validate({ version: 1, sleep: [one, sleep(one.end_time, '2024-01-01T02:00:00Z')] }).sleep.length, 2);
  assert.throws(() => validate({ version: 1, sleep: [one, two] }), /overlap/);
  assert.throws(() => validate({ version: 1, sleep: [sleep(one.start_time, null)] }), /sleep/);
  assert.throws(() => validate({ version: 1, sleep: [sleep('2024-02-30T00:00:00Z', '2024-03-02T00:00:00Z')] }), /sleep/);
  assert.throws(() => validate({ version: 1, sleep: [sleep('2099-01-01T00:00:00Z', '2099-01-01T01:00:00Z')] }), /sleep/);
});

test('validates section data without inventing absent sections', () => {
  const data = validate({ version: 1, settings: { day_start: '07:30' } });
  assert.equal(data.settings.day_start, '07:30');
  assert.equal(Object.hasOwn(data, 'sleep'), false);
  assert.throws(() => validate({ version: 1, settings: { day_start: '24:00' } }), /settings/);
  assert.throws(() => validate({ version: 1, milestones: [{ date: '2024-01-01', description: '' }] }), /milestone/);
});
