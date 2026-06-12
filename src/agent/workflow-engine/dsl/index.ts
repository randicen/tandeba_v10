/**
 * Worgena Workflow DSL — barrel export.
 *
 * Este módulo expone el DSL (tipos + validación + parser) al resto del motor.
 * El executor y las primitivas (D2a.2+) lo consumen.
 */

export * from "./types.js";
export {
  workflowSchemaJson,
  validateWorkflow,
  validateWorkflowSchema,
  type CrossValidationError,
  type ValidationResult,
} from "./schema.js";
export {
  parseWorkflow,
  parseWorkflowFile,
  parseJsonPointer,
  type Format,
  type ParseError,
  type ParseErrorCode,
  type ParseResult,
} from "./parser.js";
