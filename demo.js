import assert from 'node:assert/strict';
import { compile } from './compile.js';
import { model, contracts, schema, expected } from './examples/data.js';
import { openDatabase, normalizeRows } from './examples/database.js';

function displayRow(row) {
  const display = { ...row };
  if (row.is_total) display.region = 'Total';
  for (const key of Object.keys(row)) {
    if (key.endsWith('_pct_change') && row[key] !== null) {
      display[key] = `${row[key].toFixed(1)}%`;
    }
  }
  return display;
}

async function main() {
  const database = await openDatabase('duckdb');
  try {
    await database.exec(schema);
    for (const [name, contract] of Object.entries(contracts)) {
      const sql = compile(model, contract, 'duckdb');
      const rows = normalizeRows(await database.query(sql));
      assert.deepEqual(rows, expected[name]);

      console.log(`\nContract ${name}\n${sql}`);
      console.table(rows.map(displayRow));
      console.log(`Contract ${name}: PASS`);
    }
  } finally {
    await database.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
