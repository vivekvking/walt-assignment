import { fail } from "./validate.js";

function quoteName(name) {
	return `"${name.replaceAll('"', '""')}"`;
}

function quoteValue(value) {
	if (typeof value === "string") {
		return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
	}
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	return String(value);
}

const dialects = {
	duckdb: { number: (expression) => `CAST(${expression} AS DOUBLE)` },
	postgres: { number: (expression) => `CAST(${expression} AS DOUBLE PRECISION)` },
};

export function getDialect(name) {
	if (typeof name !== "string" || !Object.hasOwn(dialects, name)) {
		fail("UNSUPPORTED_DIALECT", "dialect", "expected duckdb or postgres");
	}
	return dialects[name];
}

function column(table, name) {
	return `${quoteName(table)}.${quoteName(name)}`;
}

function dimensionColumn(dimension) {
	return column(dimension.model, dimension.name);
}

function filterSql(filter) {
	return `${dimensionColumn(filter.dimension)} = ${quoteValue(filter.value)}`;
}

function comparisonColumn(compare) {
	return `CAST(${dimensionColumn(compare.dimension)} AS VARCHAR)`;
}

function metricName(metricIndex, periodIndex) {
	return `metric_${metricIndex}_period_${periodIndex}`;
}

function aggregateSql(metric, compare, period) {
	const conditions = metric.filters.map(filterSql);
	if (compare) conditions.push(`${comparisonColumn(compare)} = ${quoteValue(period)}`);

	let value = column(metric.model, metric.expression);
	if (conditions.length) value = `CASE WHEN ${conditions.join(" AND ")} THEN ${value} END`;

	return metric.agg === "sum" ? `SUM(${value})` : `COUNT(DISTINCT ${value})`;
}

// First calculate all metric values at both detail and total grains.
function buildAggregation(query) {
	const groups = query.dimensions.map(dimensionColumn);
	const columns = groups.map((group, index) => `${group} AS ${quoteName(`group_${index}`)}`);

	if (query.totals) {
		const totalFlag = groups.length ? `GROUPING(${groups[0]}) = 1` : "TRUE";
		columns.push(`${totalFlag} AS "is_total"`);
	}

	const periods = query.compare ? query.compare.periods : [undefined];
	for (const [metricIndex, metric] of query.metrics.entries()) {
		for (const [periodIndex, period] of periods.entries()) {
			const value = aggregateSql(metric, query.compare, period);
			columns.push(`${value} AS ${quoteName(metricName(metricIndex, periodIndex))}`);
		}
	}

	const sql = [`SELECT\n    ${columns.join(",\n    ")}`, `FROM ${quoteName(query.baseTable)}`];
	for (const join of query.joins) {
		sql.push(`LEFT JOIN ${quoteName(join.to)} ON ${column(join.from, join.from_column)} = ${column(join.to, join.to_column)}`);
	}

	const conditions = query.filters.map(filterSql);
	if (query.compare) {
		const values = query.compare.periods.map(quoteValue).join(", ");
		conditions.push(`${comparisonColumn(query.compare)} IN (${values})`);
	}
	if (conditions.length) sql.push(`WHERE ${conditions.join(" AND ")}`);

	if (groups.length) {
		const groupList = groups.join(", ");
		sql.push(query.totals ? `GROUP BY GROUPING SETS ((${groupList}), ())` : `GROUP BY ${groupList}`);
	}
	return sql.map((line) => `  ${line}`).join("\n");
}

// Then calculate changes from each row's own values, including the total row.
function buildResults(query, dialect) {
	const resultColumn = (name) => column("result", name);
	const columns = query.dimensions.map((dimension, index) => `${resultColumn(`group_${index}`)} AS ${quoteName(dimension.name)}`);

	for (const [metricIndex, metric] of query.metrics.entries()) {
		if (!query.compare) {
			columns.push(`${resultColumn(metricName(metricIndex, 0))} AS ${quoteName(metric.alias)}`);
			continue;
		}

		const compare = query.compare;
		const primaryIndex = compare.periods.indexOf(compare.primary);
		const primary = resultColumn(metricName(metricIndex, primaryIndex));
		const previous = resultColumn(metricName(metricIndex, 1 - primaryIndex));

		for (const output of compare.outputs) {
			if (output === "values") {
				for (const [periodIndex, period] of compare.periods.entries()) {
					const value = resultColumn(metricName(metricIndex, periodIndex));
					columns.push(`${value} AS ${quoteName(`${metric.alias}_${period}`)}`);
				}
			} else if (output === "delta") {
				columns.push(`(${primary} - ${previous}) AS ${quoteName(`${metric.alias}_delta`)}`);
			} else {
				const difference = `${dialect.number(primary)} - ${dialect.number(previous)}`;
				const percent = `100.0 * (${difference}) / NULLIF(${dialect.number(previous)}, 0)`;
				columns.push(`(${percent}) AS ${quoteName(`${metric.alias}_pct_change`)}`);
			}
		}
	}

	if (query.totals) columns.push(`${resultColumn("is_total")} AS "is_total"`);

	const sql = [`SELECT\n  ${columns.join(",\n  ")}`, 'FROM "aggregated" AS "result"'];
	const order = [];
	if (query.totals) order.push(`${resultColumn("is_total")} ASC`);
	for (const [index] of query.dimensions.entries()) {
		order.push(`${resultColumn(`group_${index}`)} ASC NULLS LAST`);
	}
	if (order.length) sql.push(`ORDER BY ${order.join(", ")}`);
	return sql.join("\n");
}

export function buildSql(query, dialect) {
	const aggregation = buildAggregation(query);
	return `WITH "aggregated" AS (\n${aggregation}\n)\n${buildResults(query, dialect)};\n`;
}
