/**
 * Public engine API surface. Framework-free — reused unchanged by the extension popup
 * and the future web app. Import via the `@engine/*` path alias.
 *
 * Build-out is tracked in docs/tasks.md (P1). Nothing here is stubbed or faked:
 * only genuinely implemented pieces are exported (CLAUDE.md hard rule 1).
 */

export type {
  AnonymizeResult,
  DeterministicEntityType,
  EntityType,
  KeyRow,
  NerEntityType,
  Recognizer,
  Span,
} from "./types";
export { PRIORITY } from "./types";

export { isValidIsraeliId, israeliIdRecognizer } from "./recognizers/israeliId";
export { isValidIsraeliPhone, israeliPhoneRecognizer } from "./recognizers/israeliPhone";
export { isValidIsraeliCompany, israeliCompanyRecognizer } from "./recognizers/israeliCompany";
export { labeledRecognizer } from "./recognizers/labeled";
export { israeliOrgRecognizer } from "./recognizers/israeliOrg";
export { isValidIsraeliIban, israeliIbanRecognizer } from "./recognizers/israeliIban";
export { israeliCaseRecognizer } from "./recognizers/israeliCase";
export { israeliLandRecognizer } from "./recognizers/israeliLand";
export { israeliPolicyRecognizer } from "./recognizers/israeliPolicy";
export { israeliInsuredRecognizer } from "./recognizers/israeliInsured";
export { emailRecognizer } from "./recognizers/email";
export { resolveOverlaps } from "./resolve";
export {
  DETERMINISTIC_RECOGNIZERS,
  anonymizeDeterministic,
  anonymizeFull,
  detectDeterministic,
} from "./pipeline";
export { anonymize, placeholderFor } from "./anonymize";
export { fromCsv, fromKeyFile, toCsv, toKeyFile } from "./key";
export type { KeyFile } from "./key";
export { restore } from "./restore";
export type { RestoreResult } from "./restore";
export {
  createHebrewNer,
  installTokenizerRegexShim,
  mapNerTag,
  reconstructNerSpans,
} from "./ner";
export type { HebrewNer, HebrewNerOptions, RawNerSpan } from "./ner";
