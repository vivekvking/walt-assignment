// Only the demo and tests open databases. The compiler has no database dependency.
export async function openDatabase(dialect) {
  if (dialect === 'duckdb') {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    let connection;
    try {
      connection = await instance.connect();
    } catch (error) {
      instance.closeSync();
      throw error;
    }
    return {
      exec: sql => connection.run(sql),
      query: async sql => {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowObjects();
      },
      close: async () => { connection.closeSync(); instance.closeSync(); },
    };
  }
  if (dialect === 'postgres') {
    const { PGlite } = await import('@electric-sql/pglite');
    const database = new PGlite({ parsers: { 20: BigInt } });
    return {
      exec: sql => database.exec(sql),
      query: async sql => (await database.query(sql)).rows,
      close: () => database.close(),
    };
  }
  throw new Error(`Unknown test database ${dialect}`);
}

// Drivers expose BIGINT differently. Normalize only safely representable counts.
export function normalizeRows(rows) {
  return rows.map(row => {
    const result = { ...row };
    for (const [name, value] of Object.entries(row)) {
      if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) {
        result[name] = Number(value);
      }
    }
    return result;
  });
}
