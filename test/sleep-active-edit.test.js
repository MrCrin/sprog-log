const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const validators = source.slice(source.indexOf('function validSleepTimestamp'), source.indexOf('function matchesExpectedSleep'));
const route = source.slice(source.indexOf("app.put('/api/sleep/active/start'"), source.indexOf("app.post('/api/sleep/stop'"));

function setup(active, completed = []) {
  let handler;
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT 1')) {
        return { rows: completed.some(entry => Date.parse(entry.end_time) > Date.parse(params[1])) ? [{}] : [] };
      }
      if (sql.startsWith('UPDATE')) {
        active.start_time = new Date(params[0]);
        return { rows: [active] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const context = vm.createContext({
    app: { put: (path, fn) => { handler = fn; } },
    activeSleep: async () => active,
    sleepConflict: async (client, error) => ({ status: 409, body: { error, active } }),
    sleepMutation: async (res, operation) => {
      const result = await operation(client);
      res.status(result.status || 200).json(result.body);
    }
  });
  vm.runInContext(validators + route, context);
  return { handler, queries };
}

async function request(handler, body) {
  const response = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ body }, response);
  return response;
}

const active = () => ({ id: 7, start_time: new Date('2024-01-02T12:00:00Z'), end_time: null });
const body = () => ({ id: 7, start_time: '2024-01-02T11:00:00Z', expected_start_time: '2024-01-02T13:00:00+01:00' });

test('updates active start using equivalent expected instant and allows adjacent completed sleep', async () => {
  const { handler, queries } = setup(active(), [{ end_time: '2024-01-02T11:00:00Z' }]);
  const res = await request(handler, body());
  assert.equal(res.code, 200);
  assert.equal(res.body.start_time.toISOString(), '2024-01-02T11:00:00.000Z');
  assert.equal(res.body.end_time, null);
  assert.equal(queries.length, 2);
});

test('rejects invalid and future start timestamps', async () => {
  const { handler, queries } = setup(active());
  for (const start_time of ['2024-02-30T12:00:00Z', '2024-01-02T11:00', '2099-01-01T00:00:00Z', null]) {
    assert.equal((await request(handler, { ...body(), start_time })).code, 400);
  }
  assert.equal(queries.length, 0);
});

test('rejects stale identity or expected start and missing active sleep', async () => {
  for (const [entry, changes] of [[active(), { id: 8 }], [active(), { expected_start_time: '2024-01-02T10:00:00Z' }], [active(), { expected_start_time: null }], [null, {}]]) {
    const { handler, queries } = setup(entry);
    const res = await request(handler, { ...body(), ...changes });
    assert.equal(res.code, 409);
    assert.equal(res.body.active, entry);
    assert.equal(queries.length, 0);
  }
});

test('rejects overlap with completed sleep and returns current active', async () => {
  const entry = active();
  const { handler, queries } = setup(entry, [{ end_time: '2024-01-02T11:00:00.001Z' }]);
  const res = await request(handler, body());
  assert.equal(res.code, 409);
  assert.match(res.body.error, /overlaps/);
  assert.equal(res.body.active, entry);
  assert.equal(queries.length, 1);
});
