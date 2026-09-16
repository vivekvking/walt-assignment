import assert from 'node:assert/strict';
import { normalizeRows } from '../examples/database.js';

export function assertRows(actual, expected) {
  const rows = normalizeRows(actual);
  assert.equal(rows.length, expected.length, 'row count');
  rows.forEach((row, i) => {
    assert.deepEqual(Object.keys(row), Object.keys(expected[i]), `column order at row ${i}`);
    for (const [key, value] of Object.entries(expected[i])) {
      if (typeof value === 'number') {
        assert.equal(typeof row[key], 'number', `numeric cell ${i}.${key}`);
        assert.ok(Math.abs(row[key] - value) <= 1e-9 * Math.max(1, Math.abs(value)), `${i}.${key}: expected ${value}, received ${row[key]}`);
      } else assert.deepEqual(row[key], value, `${i}.${key}`);
    }
  });
}
