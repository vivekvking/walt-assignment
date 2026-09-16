import { validateModel, validateContract } from './compiler/validate.js';
import { findJoins } from './compiler/joins.js';
import { getDialect, buildSql } from './compiler/sql.js';

export { CompileError } from './compiler/validate.js';

// Input: a semantic model, a query contract, and 'duckdb' or 'postgres'.
// Output: SQL text. This function does not connect to a database.
export function compile(semanticModel, contract, dialect) {
  const sqlDialect = getDialect(dialect);
  const model = validateModel(semanticModel);
  const query = validateContract(contract, model);
  const { baseTable, joins } = findJoins(model, query);

  return buildSql({ ...query, baseTable, joins }, sqlDialect);
}
