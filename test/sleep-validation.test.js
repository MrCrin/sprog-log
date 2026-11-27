const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const validators = source.slice(source.indexOf('function validSleepTimestamp'), source.indexOf('function matchesExpectedSleep'));
const context = vm.createContext({});
vm.runInContext(validators + '\nthis.validate = validateSleepInterval;', context);
const validate = context.validate;

test('sleep intervals require valid timezone-qualified, ordered past instants', () => {
  assert.equal(validate('2024-02-29T12:00:00Z', '2024-02-29T13:00:00Z'), null);
  assert.match(validate('2024-02-30T12:00:00Z', '2024-03-01T13:00:00Z'), /valid timestamps/);
  assert.match(validate('2024-01-01T12:00', '2024-01-01T13:00'), /valid timestamps/);
  assert.match(validate('2024-01-01T12:00:00Z', '2024-01-01T12:00:00Z'), /after/);
  assert.match(validate('2099-01-01T12:00:00Z', '2099-01-01T13:00:00Z'), /future/);
});
