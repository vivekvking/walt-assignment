import { fail } from './validate.js';

export function findJoins(model, query) {
  const baseTable = query.metrics[0].model;
  const relationships = [...model.relationships].sort((first, second) => {
    const firstKey = JSON.stringify([first.from, first.to, first.from_column, first.to_column]);
    const secondKey = JSON.stringify([second.from, second.to, second.from_column, second.to_column]);
    return firstKey < secondKey ? -1 : firstKey > secondKey ? 1 : 0;
  });

  const paths = new Map();
  const visiting = new Set();

  function visit(table, path) {
    if (visiting.has(table)) {
      fail('UNSUPPORTED_FEATURE', 'model.relationships', 'cyclic relationships are unsupported');
    }

    const tablePaths = paths.get(table) ?? [];
    // Two paths are enough to identify an ambiguous join. Do not enumerate more.
    if (tablePaths.length === 2) return;
    tablePaths.push(path);
    paths.set(table, tablePaths);

    visiting.add(table);
    for (const relationship of relationships) {
      if (relationship.from === table) {
        visit(relationship.to, [...path, relationship]);
      }
    }
    visiting.delete(table);
  }

  visit(baseTable, []);

  const tables = new Set(query.dimensions.map(dimension => dimension.model));
  const filters = [...query.filters, ...query.metrics.flatMap(metric => metric.filters)];
  for (const filter of filters) tables.add(filter.dimension.model);
  if (query.compare) tables.add(query.compare.dimension.model);

  const joins = new Map();
  for (const table of [...tables].sort()) {
    const tablePaths = paths.get(table) ?? [];
    if (tablePaths.length === 0) {
      fail('MISSING_JOIN_PATH', 'model.relationships', `no many_to_one path from ${baseTable} to ${table}`);
    }
    if (tablePaths.length > 1) {
      fail('AMBIGUOUS_JOIN_PATH', 'model.relationships', `multiple paths from ${baseTable} to ${table}`);
    }

    // Paths already list parent tables before children; shared joins are added once.
    for (const relationship of tablePaths[0]) joins.set(relationship.to, relationship);
  }

  return { baseTable, joins: [...joins.values()] };
}
