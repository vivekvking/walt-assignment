# Query contract to SQL

It converts a semantic model and a JSON contract into DuckDB or PostgreSQL SQL. All three supplied contracts are implemented.

## Run

Requires Node.js 22+ and npm. From this folder:

```sh
npm ci && npm run demo
```

This installs dependencies, creates an in-memory DuckDB database, and prints the SQL and checked results for A, B, and C. No server, Docker, credentials, or database setup is needed. A failed check exits with a nonzero status.

```sh
npm ci && npm test
npm ci && npm run bench
```

After installation, use `npm run demo`, `npm test`, or `npm run bench` directly. Installation needs internet access; the programs run locally afterward.

## Code layout

```text
compile.js              Public function; start here
compiler/
  validate.js           Check inputs and resolve metric/dimension names
  joins.js              Find the required table relationships
  sql.js                Build the SQL for the chosen database
examples/
  model.json            Supplied semantic model
  contracts.json        Contracts A, B, and C
  data.sql              Supplied tables and rows
  data.js               Load examples and define expected results
  database.js           Open and close databases for demo/tests
tests/
  sql.test.js           Run generated SQL on both databases
  validation.test.js    Check errors and deterministic output
  assertions.js         Compare query results
demo.js                 Run the assignment examples
benchmark.js            Measure compilation time
```

## Usage

```js
import { compile } from './compile.js';
import { model, contracts } from './examples/data.js';

const sql = compile(model, contracts.B, 'postgres');
```

The public function is `compile(semanticModel, contract, dialect) -> sqlString`. It is synchronous, does not change its inputs, and makes no database, network, or LLM calls.

The flow is **validate inputs → find joins → build SQL**. The compiler works with declared names and relationships rather than recognizing A, B, or C. Tests also use a separate shipments model.

Plain JavaScript keeps the solution small. There is no ORM or query builder: deciding which rows and groups a metric should use is the main work here. `@duckdb/node-api` executes the demo SQL, and PGlite runs PostgreSQL in-process for tests. Neither library generates SQL. Tests use Node's built-in test runner.

## SQL choices

**Joins.** Follow declared many-to-one relationships, including multiple steps. Use `LEFT JOIN` so a missing store or calendar row does not remove a sale. A global dimension filter goes in `WHERE` and intentionally restricts those rows. A metric-local filter stays inside that metric's aggregate. Missing or ambiguous join paths produce an error; the compiler never guesses a date relationship.

**Contract A.** Online revenue uses `SUM(CASE WHEN channel = 'Online' THEN revenue END)`. Total revenue uses `SUM(revenue)`. Both share the fiscal-year filter, giving 420 and 710.

**Contract B.** The inner query calculates each period's values for each region and the grand total. The outer query calculates delta and percentage change from each row's own values. The total percentage is `100 × (710 - 450) / 450 = 57.8%`, rounded for display.

**Contract C.** `GROUPING SETS ((region), ())` calculates both region aggregates and a separate aggregate over the whole filtered base. Its `COUNT(DISTINCT order_id)` returns a total of 8. Adding the regional counts would return 9 because O-203 belongs to two regions.

**Dialects.** Contract validation and join selection are shared. Database-specific rendering stays in `compiler/sql.js`; percentage calculations use `DOUBLE` for DuckDB and `DOUBLE PRECISION` for PostgreSQL. The remaining SQL syntax is shared by both engines.

## Supported behavior and limits

- Metrics: `sum`/additive and `count_distinct`/distinct_count, with aliases and independent filters. Multiple metrics must use the same fact dataset.
- Grouping: zero or more declared dimensions. Global and local filters support equality, combined with AND.
- Comparison: two distinct string periods, a primary period, and any nonempty subset of `values`, `delta`, and `pct_change`. The comparison dimension cannot also be grouped.
- Totals: `grand`, or omitted. Totals include `is_total` so they can be distinguished from a real NULL-dimension group. The demo labels them “Total.”
- Empty sums remain NULL; distinct counts return zero. A missing revenue period therefore makes its delta and percentage NULL. A zero baseline produces a NULL percentage.
- Percentages are unrounded numbers in percentage units; 150 means 150%. Rows sort by grouping dimensions with nulls last, followed by the total.
- Periods match the dimension cast to text because the supplied model has no column types. Labels must match that text representation; a richer model could use typed comparisons.
- Model names and column expressions are simple, unqualified identifiers. Output aliases are quoted and string values are escaped. Names, including generated output names, must fit 63 UTF-8 bytes and cannot conflict by case.
- Unknown properties, names, operators, and unsupported features fail with `CompileError`, containing `code`, `path`, and `message`. Examples include `UNKNOWN_METRIC`, `UNSUPPORTED_FEATURE`, and `AMBIGUOUS_JOIN_PATH`.

The full model is validated, including unused declarations. Unsupported cardinalities and duplicate declarations fail; reachable cycles and required ambiguous paths also fail. Filters must reference declared dimensions. Null equality, arbitrary SQL expressions, self-joins, and multiple fact datasets are unsupported.

The model owner is responsible for physical column types, column existence, and truthful many-to-one relationships. A duplicated dimension key can multiply facts; compilation cannot inspect the warehouse to detect it.

## Verification and timing

The 120 tests cover the supplied answers, combinations of supported features, missing dimensions, filtered distinct totals, zero/missing periods, quoted values, invalid inputs, multi-step joins, and repeatability across processes. SQL execution cases run on both DuckDB and PostgreSQL through PGlite.

Measured after the rewrite on an Apple M4 Pro, macOS ARM64, Node.js v26.5.0. Times are milliseconds:

| Contract | Dialect | First call | Median | p95 | Maximum |
| --- | --- | ---: | ---: | ---: | ---: |
| A | DuckDB | 0.7558 | 0.0063 | 0.0080 | 0.4768 |
| A | PostgreSQL | 0.8558 | 0.0060 | 0.0076 | 0.3851 |
| B | DuckDB | 0.7868 | 0.0079 | 0.0092 | 0.3440 |
| B | PostgreSQL | 0.9021 | 0.0079 | 0.0099 | 0.3567 |
| C | DuckDB | 0.6812 | 0.0052 | 0.0059 | 0.6028 |
| C | PostgreSQL | 0.6991 | 0.0052 | 0.0060 | 0.1424 |

Each first call runs in a fresh process. Warm measurements use 1,000 warm-up calls and 10,000 measured calls. The timer includes validation, join resolution, and SQL generation; it excludes imports, JSON parsing, process startup, and database execution. No output cache is used. These observations are below 10 ms, not a guarantee for arbitrary model sizes or machine load.

## Extensions and tradeoffs

**HAVING:** Add validation for aggregate predicates and carry them into SQL generation. First define whether filtering a detail group changes the grand total. A condition on a calculated percentage needs to run after that percentage is calculated.

**Monthly trends:** Declare the date role and time bucket in the model, then add dialect-specific date bucketing. Timezone, fiscal/calendar rules, and whether to fill missing months need explicit decisions.

**More features or larger models:** At 10× the contract vocabulary, interactions between filters, comparisons, and totals become harder to maintain. Separate feature validation and use explicit expression types as needed. The current join search scans relationships and copies paths, so larger models would benefit from indexed relationships and a reusable, validated model. Very deep relationships would need an iterative traversal.

**A second fact table:** Aggregate each fact to a compatible grouping level before combining them. Joining raw fact rows can multiply measures. Shared dimensions and distinct identities must be declared before this is supported.

No required example was cut. Extra filter operators, calculated metric expressions, and the extensions above are left for a concrete requirement.
