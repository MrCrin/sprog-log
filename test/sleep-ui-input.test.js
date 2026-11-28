const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
const source = html.slice(html.indexOf('    function sleepLocalInput('), html.indexOf('    function NightDisplayRow('));
const { sleepLocalInput, sleepInputInstant } = vm.runInNewContext(source + '\n({ sleepLocalInput, sleepInputInstant })');

test('override-only edits preserve precise sleep timestamps', () => {
  const timestamp = '2024-01-01T12:34:56.789Z';
  const value = sleepLocalInput(timestamp);
  assert.equal(sleepInputInstant(value, timestamp), timestamp);
  const changed = sleepLocalInput('2024-01-01T12:35:56.000Z');
  assert.equal(sleepInputInstant(changed, timestamp), '2024-01-01T12:35:56.000Z');
  assert.equal(sleepInputInstant(changed, null), '2024-01-01T12:35:56.000Z');
});
