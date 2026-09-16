export class CompileError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = 'CompileError';
    this.code = code;
    this.path = path;
  }
}

export function fail(code, path, message) {
  throw new CompileError(code, path, message);
}

function checkObject(value, path, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('INVALID_INPUT', path, 'expected a JSON object');
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) fail('UNSUPPORTED_FEATURE', `${path}.${key}`, 'unsupported property');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('INVALID_INPUT', `${path}.${key}`, 'required property');
  }
}

function checkArray(value, path, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    fail('INVALID_INPUT', path, `expected ${nonempty ? 'a nonempty' : 'an'} array`);
  }
  // Sparse arrays are not JSON arrays and would otherwise skip validation callbacks.
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) fail('INVALID_INPUT', `${path}[${i}]`, 'missing array item');
  }
}

function checkString(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !value.isWellFormed()) {
    fail('INVALID_INPUT', path, 'expected a nonempty, well-formed string without NUL');
  }
  return value;
}

function checkIdentifier(value, path) {
  checkOutputName(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail('UNSUPPORTED_FEATURE', path, 'expected a simple column or model identifier, not a SQL expression or qualified name');
  }
  return value;
}

function checkOutputName(value, path) {
  checkString(value, path);
  if (Buffer.byteLength(value, 'utf8') > 63) {
    fail('INVALID_INPUT', path, 'output identifiers must fit PostgreSQL\'s 63-byte limit');
  }
  return value;
}

function findByName(map, name, path, kind) {
  checkString(name, path);
  if (!map.has(name)) fail(`UNKNOWN_${kind}`, path, `unknown ${kind.toLowerCase()} ${JSON.stringify(name)}`);
  return map.get(name);
}

function indexByName(items, path, validate) {
  checkArray(items, path);
  const result = new Map();
  const portableNames = new Set();
  items.forEach((item, i) => {
    const entryPath = `${path}[${i}]`;
    validate(item, entryPath);
    if (portableNames.has(item.name.toLowerCase())) fail('INVALID_MODEL', `${entryPath}.name`, `duplicate or case-conflicting name ${item.name}`);
    portableNames.add(item.name.toLowerCase());
    result.set(item.name, { ...item });
  });
  return result;
}

// Check the declared model. Physical column types and data are not available here.
export function validateModel(model) {
  checkObject(model, 'model', ['datasets', 'relationships', 'metrics', 'dimensions']);
  const datasets = indexByName(model.datasets, 'model.datasets', (item, path) => {
    checkObject(item, path, ['name', 'grain']);
    checkIdentifier(item.name, `${path}.name`);
    checkString(item.grain, `${path}.grain`);
  });
  if (!datasets.size) fail('INVALID_MODEL', 'model.datasets', 'at least one dataset is required');
  const metrics = indexByName(model.metrics, 'model.metrics', (item, path) => {
    checkObject(item, path, ['name', 'model', 'agg', 'expression', 'measure_class']);
    checkIdentifier(item.name, `${path}.name`);
    findByName(datasets, item.model, `${path}.model`, 'DATASET');
    checkIdentifier(item.expression, `${path}.expression`);
    const classes = { sum: 'additive', count_distinct: 'distinct_count' };
    if (!['sum', 'count_distinct'].includes(item.agg)) fail('UNSUPPORTED_FEATURE', `${path}.agg`, 'supported aggregates are sum and count_distinct');
    if (item.measure_class !== classes[item.agg]) fail('INVALID_MODEL', `${path}.measure_class`, `expected ${classes[item.agg]} for ${item.agg}`);
  });
  const dimensions = indexByName(model.dimensions, 'model.dimensions', (item, path) => {
    checkObject(item, path, ['name', 'model']);
    checkIdentifier(item.name, `${path}.name`);
    findByName(datasets, item.model, `${path}.model`, 'DATASET');
  });
  checkArray(model.relationships, 'model.relationships');
  const edgeKeys = new Set();
  const relationships = model.relationships.map((item, i) => {
    const path = `model.relationships[${i}]`;
    checkObject(item, path, ['from', 'from_column', 'to', 'to_column', 'cardinality']);
    findByName(datasets, item.from, `${path}.from`, 'DATASET');
    findByName(datasets, item.to, `${path}.to`, 'DATASET');
    checkIdentifier(item.from_column, `${path}.from_column`);
    checkIdentifier(item.to_column, `${path}.to_column`);
    if (item.cardinality !== 'many_to_one') fail('UNSAFE_JOIN', `${path}.cardinality`, 'only declared many_to_one relationships are supported');
    if (item.from === item.to) fail('UNSUPPORTED_FEATURE', path, 'self-joins require role aliases and are unsupported');
    const key = JSON.stringify([item.from, item.from_column, item.to, item.to_column]);
    if (edgeKeys.has(key)) fail('INVALID_MODEL', path, 'duplicate relationship');
    edgeKeys.add(key);
    return { ...item };
  });
  return { datasets, metrics, dimensions, relationships };
}

function checkFilterValue(value, path) {
  if (typeof value === 'string' && !value.includes('\0') && value.isWellFormed()) return;
  if (typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  fail('INVALID_INPUT', path, 'expected a string, boolean, or finite safe number; null equality is unsupported');
}

function validateFilters(items, path, model) {
  checkArray(items, path);
  return items.map((item, i) => {
    const at = `${path}[${i}]`;
    checkObject(item, at, ['field', 'model', 'op', 'value']);
    const dimension = findByName(model.dimensions, item.field, `${at}.field`, 'DIMENSION');
    if (item.model !== dimension.model) fail('INVALID_REFERENCE', `${at}.model`, `field ${item.field} belongs to ${dimension.model}`);
    if (item.op !== '=') fail('UNSUPPORTED_FEATURE', `${at}.op`, 'only equality (=) filters are supported');
    checkFilterValue(item.value, `${at}.value`);
    return { dimension, value: item.value };
  });
}

// Resolve names and fill in optional fields without changing the original contract.
export function validateContract(contract, model) {
  checkObject(contract, 'contract', ['metrics', 'group_by', 'filters', 'compare', 'totals'], ['metrics']);
  checkArray(contract.metrics, 'contract.metrics', true);
  const metrics = contract.metrics.map((item, i) => {
    const path = `contract.metrics[${i}]`;
    checkObject(item, path, ['name', 'as', 'filters'], ['name']);
    const metric = findByName(model.metrics, item.name, `${path}.name`, 'METRIC');
    return {
      ...metric,
      alias: checkOutputName(Object.hasOwn(item, 'as') ? item.as : item.name, `${path}.as`),
      filters: validateFilters(Object.hasOwn(item, 'filters') ? item.filters : [], `${path}.filters`, model),
    };
  });
  if (new Set(metrics.map(metric => metric.model)).size !== 1) {
    fail('UNSUPPORTED_FEATURE', 'contract.metrics', 'metrics from multiple fact datasets need an explicit grain alignment strategy');
  }
  const groups = Object.hasOwn(contract, 'group_by') ? contract.group_by : [];
  checkArray(groups, 'contract.group_by');
  const dimensions = groups.map((name, i) => findByName(model.dimensions, name, `contract.group_by[${i}]`, 'DIMENSION'));
  if (new Set(groups).size !== groups.length) fail('INVALID_INPUT', 'contract.group_by', 'duplicate grouping dimension');
  const globalFilters = validateFilters(Object.hasOwn(contract, 'filters') ? contract.filters : [], 'contract.filters', model);
  if (Object.hasOwn(contract, 'totals') && contract.totals !== 'grand') {
    fail('UNSUPPORTED_FEATURE', 'contract.totals', 'only grand totals are supported');
  }
  const compare = Object.hasOwn(contract, 'compare')
    ? validateComparison(contract.compare, groups, model)
    : undefined;
  // Validate final column names too: derived names can collide even with unique metric aliases.
  const used = new Set();
  const reserve = (name, path) => {
    checkOutputName(name, path);
    const portableName = name.toLowerCase();
    if (used.has(portableName)) fail('DUPLICATE_OUTPUT', path, `output name ${JSON.stringify(name)} is already used (case-insensitive for portability)`);
    used.add(portableName);
  };
  dimensions.forEach(dimension => reserve(dimension.name, 'contract.group_by'));
  metrics.forEach((metric, i) => {
    const path = `contract.metrics[${i}].as`;
    if (!compare) reserve(metric.alias, path);
    else for (const output of compare.outputs) {
      if (output === 'values') compare.periods.forEach(period => reserve(`${metric.alias}_${period}`, path));
      else reserve(`${metric.alias}_${output}`, path);
    }
  });
  if (contract.totals === 'grand') reserve('is_total', 'contract.totals');
  return { metrics, dimensions, filters: globalFilters, compare, totals: contract.totals === 'grand' };
}

function validateComparison(input, groups, model) {
  checkObject(input, 'contract.compare', ['dimension', 'periods', 'primary', 'outputs']);
  const dimension = findByName(model.dimensions, input.dimension, 'contract.compare.dimension', 'DIMENSION');
  if (groups.includes(dimension.name)) fail('UNSUPPORTED_FEATURE', 'contract.compare.dimension', 'the pivot dimension cannot also be a grouping dimension');
  checkArray(input.periods, 'contract.compare.periods');
  if (input.periods.length !== 2) fail('UNSUPPORTED_FEATURE', 'contract.compare.periods', 'exactly two periods are supported');
  input.periods.forEach((period, i) => checkString(period, `contract.compare.periods[${i}]`));
  if (input.periods[0] === input.periods[1]) fail('INVALID_INPUT', 'contract.compare.periods', 'periods must be distinct');
  if (!input.periods.includes(input.primary)) fail('INVALID_INPUT', 'contract.compare.primary', 'primary must be one of the two periods');
  checkArray(input.outputs, 'contract.compare.outputs', true);
  input.outputs.forEach((output, i) => {
    if (!['values', 'delta', 'pct_change'].includes(output)) fail('UNSUPPORTED_FEATURE', `contract.compare.outputs[${i}]`, 'supported outputs are values, delta, and pct_change');
  });
  if (new Set(input.outputs).size !== input.outputs.length) fail('INVALID_INPUT', 'contract.compare.outputs', 'duplicate output');
  return { dimension, periods: [...input.periods], primary: input.primary, outputs: [...input.outputs] };
}
