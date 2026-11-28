const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
const source = html.slice(html.indexOf('    function validSleepDisplaySettings('), html.indexOf('    // Shared settings and portable backups.'));
const validate = vm.runInNewContext(source + '\nvalidSleepDisplaySettings');
const settings = { nap_night_mode: true, nap_night_effective_date: '2024-02-29', nap_night_bedtime: '19:00', nap_night_wake_time: '07:00' };

test('invalid display settings are detected before rendering the new timeline', () => {
  assert.equal(validate(settings), true);
  assert.equal(validate({ ...settings, nap_night_mode: false, nap_night_effective_date: null }), true);
  assert.equal(validate({ ...settings, nap_night_mode: 'true' }), false);
  assert.equal(validate({ ...settings, nap_night_effective_date: null }), false);
  assert.equal(validate({ ...settings, nap_night_effective_date: '2023-02-29' }), false);
  assert.equal(validate({ ...settings, nap_night_bedtime: '24:00' }), false);
  assert.equal(validate({ ...settings, nap_night_bedtime: '07:00' }), false);
});
