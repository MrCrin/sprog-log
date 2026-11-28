const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const validators = source.slice(source.indexOf('function validSleepTimestamp'), source.indexOf('async function overlapsSleep'));
const route = source.slice(source.indexOf("app.put('/api/sleep/:id'"), source.indexOf("app.delete('/api/sleep/:id'"));

function setup(overlaps = false) {
  let handler;
  let overlapChecks = 0;
  const entry = { id: 1, start_time: new Date('2024-01-01T00:00:00Z'), end_time: new Date('2024-01-01T01:00:00Z'), classification_override: 'nap' };
  const client = { async query(sql, params) {
    if (sql.startsWith('SELECT')) return { rows: [entry] };
    if (sql.startsWith('UPDATE sleep_entries SET classification_override')) {
      entry.classification_override = params[1];
      entry.overrideOnlyUpdate = true;
      return { rows: [entry] };
    }
    entry.start_time = new Date(params[0]);
    entry.end_time = new Date(params[1]);
    if (params.length === 4) entry.classification_override = params[3];
    return { rows: [entry] };
  } };
  const context = vm.createContext({
    app: { put: (path, fn) => { handler = fn; } },
    validOverride: value => value === null || value === 'nap' || value === 'overnight',
    activeSleep: async () => null,
    overlapsSleep: async () => { overlapChecks++; return overlaps; },
    sleepMutation: async (res, fn) => { const result = await fn(client); res.status(result.status || 200).json(result.body); }
  });
  vm.runInContext(validators + route, context);
  return { entry, handler, overlapChecks: () => overlapChecks };
}
async function request(handler, body) {
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ params: { id: '1' }, body }, res);
  return res;
}
const body = { start_time: '2024-01-01T00:00:00Z', end_time: '2024-01-01T01:00:00Z', expected_start_time: '2024-01-01T00:00:00Z', expected_end_time: '2024-01-01T01:00:00Z' };

test('ordinary edits preserve overrides and explicit null resets Auto', async () => {
  const { entry, handler } = setup();
  assert.equal((await request(handler, body)).code, 200);
  assert.equal(entry.classification_override, 'nap');
  assert.equal((await request(handler, { ...body, classification_override: null, expected_classification_override: 'nap' })).code, 200);
  assert.equal(entry.classification_override, null);
  assert.equal(entry.overrideOnlyUpdate, true); // SQL does not rewrite timestamp columns
});

test('display-only changes do not rewrite timestamps or recheck rounded adjacency', async () => {
  const { entry, handler, overlapChecks } = setup(true);
  const res = await request(handler, { ...body, classification_override: 'overnight', expected_classification_override: 'nap' });
  assert.equal(res.code, 200);
  assert.equal(entry.overrideOnlyUpdate, true);
  assert.equal(overlapChecks(), 0);
  assert.equal(entry.start_time.toISOString(), '2024-01-01T00:00:00.000Z');
  assert.equal(entry.end_time.toISOString(), '2024-01-01T01:00:00.000Z');
});

test('rejects stale or invalid overrides', async () => {
  const { entry, handler } = setup();
  assert.equal((await request(handler, { ...body, classification_override: 'overnight', expected_classification_override: null })).code, 409);
  assert.equal(entry.classification_override, 'nap');
  assert.equal((await request(handler, { ...body, classification_override: 'auto' })).code, 400);
});
