import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compile, CompileError } from '../compile.js';
import { model, contracts } from '../examples/data.js';

const clone = structuredClone;
const cases = [
  ['null model', m => null, null, 'INVALID_INPUT'],
  ['unknown model property', m => ({ ...m, sql: 'select 1' }), null, 'UNSUPPORTED_FEATURE'],
  ['empty datasets', m => ({ ...m, datasets: [] }), null, 'INVALID_MODEL'],
  ['duplicate dataset', m => ({ ...m, datasets: [...m.datasets, m.datasets[0]] }), null, 'INVALID_MODEL'],
  ['case-conflicting datasets', m => ({ ...m, datasets: [...m.datasets, { ...m.datasets[0], name: 'FACT_SALES' }] }), null, 'INVALID_MODEL'],
  ['unknown metric dataset', m => { m.metrics[0].model = 'missing'; return m; }, null, 'UNKNOWN_DATASET'],
  ['unknown dimension dataset', m => { m.dimensions[0].model = 'missing'; return m; }, null, 'UNKNOWN_DATASET'],
  ['unknown relationship dataset', m => { m.relationships[0].to = 'missing'; return m; }, null, 'UNKNOWN_DATASET'],
  ['duplicate metric', m => ({ ...m, metrics: [...m.metrics, m.metrics[0]] }), null, 'INVALID_MODEL'],
  ['duplicate dimension', m => ({ ...m, dimensions: [...m.dimensions, m.dimensions[0]] }), null, 'INVALID_MODEL'],
  ['unknown aggregate', m => { m.metrics[0].agg = 'avg'; return m; }, null, 'UNSUPPORTED_FEATURE'],
  ['array aggregate does not coerce', m => { m.metrics[0].agg = ['sum']; return m; }, null, 'UNSUPPORTED_FEATURE'],
  ['wrong measure class', m => { m.metrics[0].measure_class = 'distinct_count'; return m; }, null, 'INVALID_MODEL'],
  ['SQL expression', m => { m.metrics[0].expression = 'revenue * 2'; return m; }, null, 'UNSUPPORTED_FEATURE'],
  ['qualified table name', m => { m.datasets[0].name = 'public.fact_sales'; return m; }, null, 'UNSUPPORTED_FEATURE'],
  ['overlong identifier', m => { m.metrics[0].expression = 'x'.repeat(64); return m; }, null, 'INVALID_INPUT'],
  ['many-to-many join', m => { m.relationships[0].cardinality = 'many_to_many'; return m; }, null, 'UNSAFE_JOIN'],
  ['one-to-many join', m => { m.relationships[0].cardinality = 'one_to_many'; return m; }, null, 'UNSAFE_JOIN'],
  ['duplicate edge', m => ({ ...m, relationships: [...m.relationships, m.relationships[0]] }), null, 'INVALID_MODEL'],
  ['self join', m => { m.relationships[0].to = 'fact_sales'; return m; }, null, 'UNSUPPORTED_FEATURE'],
  ['null contract', null, c => null, 'INVALID_INPUT'],
  ['missing metrics', null, c => ({}), 'INVALID_INPUT'],
  ['empty metrics', null, c => ({ metrics: [] }), 'INVALID_INPUT'],
  ['null metric', null, c => ({ metrics: [null] }), 'INVALID_INPUT'],
  ['sparse metrics', null, c => ({ metrics: Array(1) }), 'INVALID_INPUT'],
  ['unknown metric', null, c => ({ metrics: [{ name: 'profit' }] }), 'UNKNOWN_METRIC'],
  ['unknown dimension', null, c => ({ ...c, group_by: ['unknown'] }), 'UNKNOWN_DIMENSION'],
  ['duplicate groups', null, c => ({ ...c, group_by: ['region', 'region'] }), 'INVALID_INPUT'],
  ['null groups', null, c => ({ ...c, group_by: null }), 'INVALID_INPUT'],
  ['unknown top-level feature', null, c => ({ ...c, having: [] }), 'UNSUPPORTED_FEATURE'],
  ['unknown nested metric feature', null, c => { c.metrics[0].limit = 1; return c; }, 'UNSUPPORTED_FEATURE'],
  ['unknown nested filter feature', null, c => { c.filters[0].or = true; return c; }, 'UNSUPPORTED_FEATURE'],
  ['unknown filter field', null, c => { c.filters[0].field = 'ship_date'; return c; }, 'UNKNOWN_DIMENSION'],
  ['filter model mismatch', null, c => { c.filters[0].model = 'fact_sales'; return c; }, 'INVALID_REFERENCE'],
  ['filter without model', null, c => { delete c.filters[0].model; return c; }, 'INVALID_INPUT'],
  ['unsupported filter operator', null, c => { c.filters[0].op = '>'; return c; }, 'UNSUPPORTED_FEATURE'],
  ['null equality', null, c => { c.filters[0].value = null; return c; }, 'INVALID_INPUT'],
  ['array filter value', null, c => { c.filters[0].value = [2026]; return c; }, 'INVALID_INPUT'],
  ['nonfinite value', null, c => { c.filters[0].value = Infinity; return c; }, 'INVALID_INPUT'],
  ['NaN value', null, c => { c.filters[0].value = NaN; return c; }, 'INVALID_INPUT'],
  ['unsafe integer', null, c => { c.filters[0].value = Number.MAX_SAFE_INTEGER + 1; return c; }, 'INVALID_INPUT'],
  ['NUL value', null, c => { c.filters[0].value = '\0'; return c; }, 'INVALID_INPUT'],
  ['unpaired surrogate', null, c => { c.filters[0].value = '\ud800'; return c; }, 'INVALID_INPUT'],
  ['duplicate alias', null, c => { c.metrics[0].as = 'total_revenue'; return c; }, 'DUPLICATE_OUTPUT'],
  ['case-conflicting alias', null, c => { c.metrics[0].as = 'TOTAL_REVENUE'; return c; }, 'DUPLICATE_OUTPUT'],
  ['alias collides with dimension', null, c => { c.group_by = ['region']; c.metrics[0].as = 'region'; return c; }, 'DUPLICATE_OUTPUT'],
  ['alias collides with total marker', null, c => { c.totals = 'grand'; c.metrics[0].as = 'is_total'; return c; }, 'DUPLICATE_OUTPUT'],
  ['empty alias', null, c => { c.metrics[0].as = ''; return c; }, 'INVALID_INPUT'],
  ['overlong Unicode alias', null, c => { c.metrics[0].as = 'é'.repeat(32); return c; }, 'INVALID_INPUT'],
  ['unknown totals', null, c => ({ ...c, totals: 'subtotal' }), 'UNSUPPORTED_FEATURE'],
  ['missing calendar path', m => ({ ...m, relationships: [] }), null, 'MISSING_JOIN_PATH'],
  ['multiple fact metrics', m => { m.metrics[1].model = 'dim_store'; return m; }, c => ({ metrics: [{ name: 'total_revenue' }, { name: 'order_count' }] }), 'UNSUPPORTED_FEATURE'],
  ['ambiguous date roles', m => ({ ...m, relationships: [...m.relationships, { ...m.relationships[1], from_column: 'ship_date' }] }), null, 'AMBIGUOUS_JOIN_PATH'],
  ['reachable cycle', m => ({ ...m, relationships: [...m.relationships, { from: 'dim_store', from_column: 'store_id', to: 'fact_sales', to_column: 'store_id', cardinality: 'many_to_one' }] }), null, 'UNSUPPORTED_FEATURE'],
];

for (const [name, changeModel, changeContract, code] of cases) {
  test(`refuses ${name}`, () => {
    const m = changeModel ? changeModel(clone(model)) : clone(model);
    const c = changeContract ? changeContract(clone(contracts.A)) : clone(contracts.A);
    assert.throws(() => compile(m, c, 'duckdb'), error => {
      assert.ok(error instanceof CompileError);
      assert.equal(error.name, 'CompileError');
      assert.equal(error.code, code);
      assert.match(error.path, /^(model|contract)/);
      assert.ok(error.message.startsWith(`${error.path}: `));
      return true;
    });
  });
}

const comparisonCases = [
  ['null comparison', c => { c.compare = null; }, 'INVALID_INPUT'],
  ['unknown comparison property', c => { c.compare.mode = 'yoy'; }, 'UNSUPPORTED_FEATURE'],
  ['unknown comparison dimension', c => { c.compare.dimension = 'month'; }, 'UNKNOWN_DIMENSION'],
  ['missing primary', c => { delete c.compare.primary; }, 'INVALID_INPUT'],
  ['primary not in periods', c => { c.compare.primary = '2024'; }, 'INVALID_INPUT'],
  ['three periods', c => { c.compare.periods.push('2027'); }, 'UNSUPPORTED_FEATURE'],
  ['numeric period', c => { c.compare.periods[0] = 2025; }, 'INVALID_INPUT'],
  ['duplicate periods', c => { c.compare.periods[0] = '2026'; }, 'INVALID_INPUT'],
  ['empty outputs', c => { c.compare.outputs = []; }, 'INVALID_INPUT'],
  ['unknown output', c => { c.compare.outputs = ['ratio']; }, 'UNSUPPORTED_FEATURE'],
  ['duplicate outputs', c => { c.compare.outputs = ['delta', 'delta']; }, 'INVALID_INPUT'],
  ['grouping pivot dimension', c => { c.group_by = ['fiscal_year']; }, 'UNSUPPORTED_FEATURE'],
  ['derived alias collision', c => { c.compare.periods = ['delta', '2026']; }, 'DUPLICATE_OUTPUT'],
];
for (const [name, change, code] of comparisonCases) {
  test(`refuses ${name}`, () => {
    const contract = clone(contracts.B);
    change(contract);
    assert.throws(() => compile(model, contract, 'postgres'), { name: 'CompileError', code });
  });
}

test('dialect is explicit and refuses unsupported values', () => {
  for (const dialect of [undefined, null, 'mysql', '__proto__', ['duckdb']]) {
    assert.throws(() => compile(model, contracts.A, dialect), { code: 'UNSUPPORTED_DIALECT' });
  }
});

test('same inputs produce identical bytes without mutation', () => {
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const m = freeze(clone(model));
  const c = freeze(clone(contracts.B));
  const original = JSON.stringify({ m, c });
  const sql = compile(m, c, 'duckdb');
  for (let i = 0; i < 100; i++) assert.equal(compile(m, c, 'duckdb'), sql);
  assert.equal(JSON.stringify({ m, c }), original);
});

test('object key and model catalog order do not change SQL', () => {
  const reordered = clone(model);
  for (const key of Object.keys(reordered)) reordered[key].reverse();
  const contract = Object.fromEntries(Object.entries(contracts.B).reverse());
  assert.equal(compile(reordered, contract, 'duckdb'), compile(model, contracts.B, 'duckdb'));
});

test('fresh processes produce byte-identical SQL for every fixture and dialect', () => {
  const script = `import {compile} from './compile.js'; import {model,contracts} from './examples/data.js'; for(const dialect of ['duckdb','postgres']) for(const contract of Object.values(contracts)) process.stdout.write(compile(model,contract,dialect));`;
  const run = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(run(), run());
});

test('omitted optional arrays mean empty arrays', () => {
  const minimal = { metrics: [{ name: 'total_revenue' }] };
  assert.equal(compile(model, minimal, 'duckdb'), compile(model, { ...minimal, filters: [], group_by: [] }, 'duckdb'));
});

test('numeric string groups are not converted by result normalization', async () => {
  const { normalizeRows } = await import('../examples/database.js');
  assert.deepEqual(normalizeRows([{ category: '123', n: 2n }]), [{ category: '123', n: 2 }]);
});

test('ambiguous paths of different lengths are rejected instead of choosing the shortest', () => {
  const m = clone(model);
  m.relationships.push({ from: 'dim_store', from_column: 'store_id', to: 'dim_calendar', to_column: 'date', cardinality: 'many_to_one' });
  assert.throws(() => compile(m, contracts.A, 'duckdb'), { code: 'AMBIGUOUS_JOIN_PATH' });
});

test('reverse traversal is not inferred from a many-to-one relationship', () => {
  const m = clone(model);
  m.relationships[1] = { from: 'dim_calendar', from_column: 'date', to: 'fact_sales', to_column: 'order_date', cardinality: 'many_to_one' };
  assert.throws(() => compile(m, contracts.A, 'duckdb'), { code: 'MISSING_JOIN_PATH' });
});

test('two requested dimensions reuse their shared intermediate join', () => {
  const m = clone(model);
  m.datasets.push({ name: 'dim_country', grain: 'one country' });
  m.relationships.push({ from: 'dim_store', from_column: 'country_id', to: 'dim_country', to_column: 'country_id', cardinality: 'many_to_one' });
  m.dimensions.push({ name: 'country', model: 'dim_country' });
  const sql = compile(m, { metrics: [{ name: 'total_revenue' }], group_by: ['region', 'country'] }, 'duckdb');
  assert.equal(sql.match(/LEFT JOIN "dim_store"/g).length, 1);
  assert.equal(sql.match(/LEFT JOIN "dim_country"/g).length, 1);
  assert.ok(sql.indexOf('LEFT JOIN "dim_store"') < sql.indexOf('LEFT JOIN "dim_country"'));
});
