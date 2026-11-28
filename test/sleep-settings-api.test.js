const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const helpers = source.slice(source.indexOf('const DISPLAY_DEFAULTS'), source.indexOf("app.get('/api/sleep'"));
const date = source.slice(source.indexOf('function backupDate'), source.indexOf('function backupTimestamp'));
const route = source.slice(source.indexOf("app.put('/api/sleep/display-settings'"), source.indexOf("app.post('/api/sleep/start'"));

function setup() {
  let handler;
  const values = {};
  const client = { async query(sql, params) { values[params[0]] = params[1]; return { rows: [] }; } };
  const context = vm.createContext({
    app: { put: (path, fn) => { handler = fn; } },
    sleepMutation: async (res, fn) => { const result = await fn(client); res.status(result.status || 200).json(result.body); }
  });
  vm.runInContext(helpers + date + route, context);
  return { handler, values };
}
async function request(handler, body) {
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ body }, res);
  return res;
}
const settings = { nap_night_mode: true, nap_night_effective_date: '2024-02-29', nap_night_bedtime: '19:00', nap_night_wake_time: '07:00' };

test('display settings save separately and use defaults for unset times', async () => {
  const { handler, values } = setup();
  const res = await request(handler, { ...settings, nap_night_bedtime: '', nap_night_wake_time: null });
  assert.equal(res.code, 200);
  assert.equal(values.nap_night_bedtime, '19:00');
  assert.equal(values.nap_night_wake_time, '07:00');
  assert.equal(values.nap_night_mode, 'true');
  assert.equal(values.nap_night_effective_date, '2024-02-29');
  assert.equal(Object.hasOwn(values, 'sleep_day_start'), false);
});

test('display settings reject invalid dates, times and missing enabled date', async () => {
  const { handler, values } = setup();
  for (const change of [{ nap_night_effective_date: '2024-02-30' }, { nap_night_effective_date: null }, { nap_night_wake_time: '19:00' }, { nap_night_bedtime: '25:00' }, { nap_night_mode: 'true' }]) {
    assert.equal((await request(handler, { ...settings, ...change })).code, 400);
  }
  assert.equal(Object.keys(values).length, 0);
});
