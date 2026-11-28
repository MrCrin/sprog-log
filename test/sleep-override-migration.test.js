const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('async function ensureSleepOverrideSchema()');
const end = source.indexOf('\n// ==========================================\n// 2. DATABASE SCHEMA BOOTSTRAP', start);
assert.notEqual(start, -1, 'sleep override migration helper exists');
assert.notEqual(end, -1, 'sleep override migration helper has a bounded section');
assert.match(source, /await ensureSleepOverrideSchema\(\)/, 'startup runs the override migration');
const migrationSource = source.slice(start, end);

test('migration enforces the override check even if the column already exists', async () => {
  const queries = [];
  const context = vm.createContext({ pool: { query: async sql => { queries.push(sql); } } });
  vm.runInContext(migrationSource + '\nthis.migrate = ensureSleepOverrideSchema;', context);
  await context.migrate();

  assert.equal(queries.length, 2);
  assert.match(queries[0], /ADD COLUMN IF NOT EXISTS classification_override TEXT/);
  assert.doesNotMatch(queries[0], /CHECK/);
  assert.match(queries[1], /DO \$migration\$/);
  assert.match(queries[1], /pg_advisory_xact_lock\(73657267, 2\)/);
  assert.match(queries[1], /FROM pg_constraint/);
  assert.match(queries[1], /conname = 'sleep_entries_classification_override_check'/);
  assert.match(queries[1], /ADD CONSTRAINT sleep_entries_classification_override_check/);
  assert.match(queries[1], /CHECK \(classification_override IS NULL OR classification_override IN \('nap', 'overnight'\)\)/);
  assert.match(queries[1], /END IF;[\s\S]*END;[\s\S]*\$migration\$;/);
});
