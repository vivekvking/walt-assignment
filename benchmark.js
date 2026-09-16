import { performance } from 'node:perf_hooks';
import { cpus, platform, arch, release } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from './compile.js';
import { model, contracts } from './examples/data.js';

// Child mode isolates each contract/dialect's first invocation from earlier compilations.
if (process.argv[2] === '--first-call') {
  const start = performance.now();
  const sql = compile(model, contracts[process.argv[3]], process.argv[4]);
  console.log(JSON.stringify({ ms: performance.now() - start, bytes: Buffer.byteLength(sql) }));
} else {
  const warmup = 1000;
  const iterations = 10000;
  console.log(JSON.stringify({ node: process.version, os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0].model, warmup, iterations }, null, 2));
  const results = [];
  for (const [name, contract] of Object.entries(contracts)) {
    for (const dialect of ['duckdb', 'postgres']) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--first-call', name, dialect], { encoding: 'utf8' });
      if (child.status !== 0) throw new Error(child.stderr || 'First-call benchmark failed');
      const first = JSON.parse(child.stdout);
      let checksum = 0;
      for (let i = 0; i < warmup; i++) checksum += compile(model, contract, dialect).length;
      const times = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const sql = compile(model, contract, dialect);
        times.push(performance.now() - start);
        checksum += sql.length;
      }
      times.sort((a, b) => a - b);
      const rounded = number => Number(number.toFixed(4));
      results.push({ contract: name, dialect, first_ms: rounded(first.ms), median_ms: rounded(times[Math.floor(iterations / 2)]), p95_ms: rounded(times[Math.ceil(iterations * 0.95) - 1]), max_ms: rounded(times.at(-1)), checksum });
    }
  }
  console.table(results);
  console.log('Full compile() calls, no memoization. Excludes imports, JSON parsing, process startup and database execution.');
  console.log('First call: fresh process for each case. Warmed timings include validation, planning and SQL rendering.');
  if (results.some(result => result.first_ms >= 10 || result.max_ms >= 10)) {
    console.log('An observation reached 10 ms; inspect scheduling/GC and report it rather than hiding it.');
  }
}
