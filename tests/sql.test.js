import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../compile.js';
import { model, contracts, schema, expected } from '../examples/data.js';
import { openDatabase, normalizeRows } from '../examples/database.js';
import { assertRows } from './assertions.js';

const filter = (field, value, model) => ({ field, op: '=', value, model });
const year2026 = filter('fiscal_year', 2026, 'dim_calendar');
const online = filter('channel', 'Online', 'fact_sales');
const revenueAndCount = [{ name: 'total_revenue' }, { name: 'order_count' }];

for (const dialect of ['duckdb', 'postgres']) {
  describe(`${dialect}: execute generated SQL`, () => {
    let db;
    before(async () => { db = await openDatabase(dialect); await db.exec(schema); });
    after(async () => { if (db) await db.close(); });
    const query = (contract, semanticModel = model) => db.query(compile(semanticModel, contract, dialect));
    // Each mutated-data scenario rolls back even if an assertion fails.
    async function changed(sql, check) {
      await db.exec('BEGIN');
      try { await db.exec(sql); await check(); }
      finally { await db.exec('ROLLBACK'); }
    }

    for (const name of ['A', 'B', 'C']) test(`assignment contract ${name}`, async () => assertRows(await query(contracts[name]), expected[name]));

    test('multiple metrics and dimensions, year filter and grand total', async () => {
      const rows = await query({ metrics: revenueAndCount, group_by: ['region', 'channel'], filters: [year2026], totals: 'grand' });
      assertRows(rows, [
        { region: 'North', channel: 'Online', total_revenue: 120, order_count: 1, is_total: false },
        { region: 'North', channel: 'Retail', total_revenue: 130, order_count: 2, is_total: false },
        { region: 'South', channel: 'Online', total_revenue: 300, order_count: 1, is_total: false },
        { region: 'South', channel: 'Retail', total_revenue: 70, order_count: 1, is_total: false },
        { region: 'West', channel: 'Retail', total_revenue: 90, order_count: 1, is_total: false },
        { region: null, channel: null, total_revenue: 710, order_count: 5, is_total: true },
      ]);
    });

    test('distinct metric with local filters recounts the grand total', async () => {
      const contract = { metrics: [{ name: 'order_count', as: 'retail_orders', filters: [filter('channel', 'Retail', 'fact_sales')] }, { name: 'order_count' }], group_by: ['region'], totals: 'grand' };
      assertRows(await query(contract), [
        { region: 'North', retail_orders: 2, order_count: 4, is_total: false },
        { region: 'South', retail_orders: 2, order_count: 3, is_total: false },
        { region: 'West', retail_orders: 1, order_count: 2, is_total: false },
        { region: null, retail_orders: 4, order_count: 8, is_total: true },
      ]);
    });

    test('multiple global and metric-local filters combine with AND', async () => {
      assertRows(await query({
        metrics: [{ name: 'total_revenue', as: 'north_online', filters: [filter('region', 'North', 'dim_store'), online] }, { name: 'total_revenue' }],
        filters: [year2026, online],
      }), [{ north_online: 120, total_revenue: 420 }]);
    });

    test('dimension-local filters do not filter other metrics or unmatched facts', async () => {
      await changed("INSERT INTO fact_sales VALUES ('missing', '2026-02-01', NULL, 'unknown', 'Online', 40)", async () => {
        assertRows(await query({ metrics: [{ name: 'total_revenue', as: 'north', filters: [filter('region', 'North', 'dim_store')] }, { name: 'total_revenue' }], filters: [year2026] }), [{ north: 250, total_revenue: 750 }]);
      });
    });

    test('global dimension filters genuinely restrict unmatched facts', async () => {
      await changed("INSERT INTO fact_sales VALUES ('missing', '2026-02-01', NULL, 'unknown', 'Online', 40)", async () => {
        assertRows(await query({ metrics: revenueAndCount, filters: [year2026, filter('region', 'North', 'dim_store')] }), [{ total_revenue: 250, order_count: 3 }]);
      });
    });

    test('unknown and null store keys survive grouping; NULL group is not the total', async () => {
      await changed("INSERT INTO fact_sales VALUES ('missing', '2026-02-01', NULL, 'unknown', 'Online', 40), ('null-key', '2026-02-01', NULL, NULL, 'Online', 10)", async () => {
        assertRows(await query({ metrics: revenueAndCount, group_by: ['region'], filters: [year2026], totals: 'grand' }), [
          { region: 'North', total_revenue: 250, order_count: 3, is_total: false },
          { region: 'South', total_revenue: 370, order_count: 2, is_total: false },
          { region: 'West', total_revenue: 90, order_count: 1, is_total: false },
          { region: null, total_revenue: 50, order_count: 2, is_total: false },
          { region: null, total_revenue: 760, order_count: 7, is_total: true },
        ]);
      });
    });

    test('actual NULL dimension values remain distinct from total markers', async () => {
      await changed("UPDATE dim_store SET region = NULL WHERE store_id = 'S4'", async () => {
        const rows = normalizeRows(await query(contracts.C));
        assert.deepEqual(rows.slice(-2), [{ region: null, order_count: 2, is_total: false }, { region: null, order_count: 8, is_total: true }]);
      });
    });

    test('missing calendar dates survive attachment but fail a year filter', async () => {
      await changed("INSERT INTO fact_sales VALUES ('missing-date', '2030-01-01', NULL, 'S1', 'Online', 40)", async () => {
        assertRows(await query({ metrics: [{ name: 'total_revenue' }], group_by: ['fiscal_year'], totals: 'grand' }), [
          { fiscal_year: 2025, total_revenue: 450, is_total: false },
          { fiscal_year: 2026, total_revenue: 710, is_total: false },
          { fiscal_year: null, total_revenue: 40, is_total: false },
          { fiscal_year: null, total_revenue: 1200, is_total: true },
        ]);
        assertRows(await query(contracts.A), expected.A);
      });
    });

    test('changing values and primary changes results without compiler changes', async () => {
      const contract = structuredClone(contracts.B);
      contract.compare.primary = '2025';
      contract.filters = [filter('region', 'South', 'dim_store')];
      assertRows(await query(contract), [
        { region: 'South', total_revenue_2025: 200, total_revenue_2026: 370, total_revenue_delta: -170, total_revenue_pct_change: -100 * 170 / 370, is_total: false },
        { region: null, total_revenue_2025: 200, total_revenue_2026: 370, total_revenue_delta: -170, total_revenue_pct_change: -100 * 170 / 370, is_total: true },
      ]);
    });

    test('comparison subsets and requested output order', async () => {
      const contract = structuredClone(contracts.B);
      contract.group_by = [];
      contract.compare.outputs = ['pct_change', 'delta'];
      assertRows(await query(contract), [{ total_revenue_pct_change: 100 * 260 / 450, total_revenue_delta: 260, is_total: true }]);
      contract.compare.outputs = ['values'];
      contract.compare.periods.reverse();
      assertRows(await query(contract), [{ total_revenue_2026: 710, total_revenue_2025: 450, is_total: true }]);
    });

    test('comparison combines filtered sums and distinct counts at total grain', async () => {
      const contract = structuredClone(contracts.B);
      contract.metrics = [{ name: 'total_revenue', as: 'online', filters: [online] }, { name: 'order_count' }];
      const rows = normalizeRows(await query(contract));
      assertRows([rows.at(-1)], [{ region: null, online_2025: 250, online_2026: 420, online_delta: 170, online_pct_change: 68, order_count_2025: 3, order_count_2026: 5, order_count_delta: 2, order_count_pct_change: 100 * 2 / 3, is_total: true }]);
    });

    test('zero baseline returns NULL percent change', async () => {
      await changed('UPDATE fact_sales SET revenue = 0 WHERE order_date < DATE \'2026-01-01\'', async () => {
        const rows = normalizeRows(await query(contracts.B));
        for (const row of rows) assert.equal(row.total_revenue_pct_change, null);
        assert.equal(rows.at(-1).total_revenue_delta, 710);
      });
    });

    test('missing periods retain SQL NULL sums and zero counts', async () => {
      const contract = structuredClone(contracts.B);
      contract.group_by = [];
      contract.metrics = revenueAndCount;
      contract.compare.periods = ['2024', '2026'];
      assertRows(await query(contract), [{ total_revenue_2024: null, total_revenue_2026: 710, total_revenue_delta: null, total_revenue_pct_change: null, order_count_2024: 0, order_count_2026: 5, order_count_delta: 5, order_count_pct_change: null, is_total: true }]);
    });

    test('comparison excludes groups only outside the requested periods', async () => {
      const contract = structuredClone(contracts.B);
      contract.compare.periods = ['2024', '2023'];
      contract.compare.primary = '2023';
      assertRows(await query(contract), [{ region: null, total_revenue_2024: null, total_revenue_2023: null, total_revenue_delta: null, total_revenue_pct_change: null, is_total: true }]);
    });

    test('no matching rows, grouped and ungrouped, with and without totals', async () => {
      const contract = { metrics: revenueAndCount, filters: [filter('channel', 'absent', 'fact_sales')] };
      assertRows(await query(contract), [{ total_revenue: null, order_count: 0 }]);
      assertRows(await query({ ...contract, group_by: ['region'] }), []);
      assertRows(await query({ ...contract, group_by: ['region'], totals: 'grand' }), [{ region: null, total_revenue: null, order_count: 0, is_total: true }]);
      assertRows(await query({ ...contract, totals: 'grand' }), [{ total_revenue: null, order_count: 0, is_total: true }]);
    });

    test('empty fact table and NULL measure cells follow aggregate semantics', async () => {
      await changed('DELETE FROM fact_sales', async () => {
        assertRows(await query({ metrics: revenueAndCount }), [{ total_revenue: null, order_count: 0 }]);
        assertRows(await query(contracts.C), [{ region: null, order_count: 0, is_total: true }]);
      });
      await changed('UPDATE fact_sales SET revenue = NULL, order_id = NULL', async () => {
        assertRows(await query({ metrics: revenueAndCount }), [{ total_revenue: null, order_count: 0 }]);
      });
    });

    test('quotes, backslashes, newlines, Unicode, and injection-like values remain data', async () => {
      const values = ["O'Reilly", "x' OR 1=1 --", 'path\\new\\file', 'line\nnext', 'café ☕', ''];
      for (const value of values) {
        // Seed independently using standard string literals (default standard_conforming_strings).
        const seedLiteral = `'${value.replaceAll("'", "''")}'`;
        await changed(`UPDATE fact_sales SET channel = ${seedLiteral} WHERE order_id = 'O-100'`, async () => {
          const name = 'quoted " revenue; --';
          assertRows(await query({ metrics: [{ name: 'total_revenue', as: name }], filters: [filter('channel', value, 'fact_sales')] }), [{ [name]: 100 }]);
        });
      }
    });

    test('user aliases cannot shadow internal aggregate cells', async () => {
      assertRows(await query({ metrics: [{ name: 'total_revenue', as: 'm0_p0' }, { name: 'order_count', as: 'g0' }] }), [{ m0_p0: 1160, g0: 8 }]);
    });

    test('contract vocabulary works on an unrelated model and multi-hop relationships', async () => {
      await changed(`
        CREATE TABLE continents (continent_id INTEGER PRIMARY KEY, continent TEXT);
        CREATE TABLE warehouses (warehouse_id INTEGER PRIMARY KEY, continent_id INTEGER);
        CREATE TABLE shipments (parcel TEXT, warehouse_id INTEGER, amount DOUBLE PRECISION, season TEXT, active BOOLEAN);
        INSERT INTO continents VALUES (1, 'East'), (2, '123');
        INSERT INTO warehouses VALUES (10, 1), (20, 2);
        INSERT INTO shipments VALUES ('P1', 10, 10.5, 'old', TRUE), ('P2', 10, 25, 'new', TRUE), ('P2', 20, 5, 'new', FALSE), ('P3', 99, 7, 'new', TRUE);
      `, async () => {
        const synthetic = {
          datasets: [{ name: 'shipments', grain: 'one parcel line' }, { name: 'warehouses', grain: 'one warehouse' }, { name: 'continents', grain: 'one continent' }],
          relationships: [{ from: 'shipments', from_column: 'warehouse_id', to: 'warehouses', to_column: 'warehouse_id', cardinality: 'many_to_one' }, { from: 'warehouses', from_column: 'continent_id', to: 'continents', to_column: 'continent_id', cardinality: 'many_to_one' }],
          metrics: [{ name: 'charges', model: 'shipments', expression: 'amount', agg: 'sum', measure_class: 'additive' }, { name: 'parcels', model: 'shipments', expression: 'parcel', agg: 'count_distinct', measure_class: 'distinct_count' }],
          dimensions: [{ name: 'continent', model: 'continents' }, { name: 'season', model: 'shipments' }, { name: 'active', model: 'shipments' }],
        };
        assertRows(await query({ metrics: [{ name: 'charges' }, { name: 'parcels' }], group_by: ['continent'], totals: 'grand' }, synthetic), [
          { continent: '123', charges: 5, parcels: 1, is_total: false },
          { continent: 'East', charges: 35.5, parcels: 2, is_total: false },
          { continent: null, charges: 7, parcels: 1, is_total: false },
          { continent: null, charges: 47.5, parcels: 3, is_total: true },
        ]);
        assertRows(await query({ metrics: [{ name: 'charges' }], filters: [filter('active', true, 'shipments')], compare: { dimension: 'season', periods: ['old', 'new'], primary: 'new', outputs: ['delta'] } }, synthetic), [{ charges_delta: 21.5 }]);
      });
    });
  });
}
