/**
 * Public error-copy surface (issue #311). Components resolve a thrown value to a user-facing
 * sentence through `useErrorMessage`; the pure classification seam (`db-error-message.ts`) is
 * reachable for non-React callers and tests.
 */
export { useErrorMessage, type ErrorMessageResolver } from './useErrorMessage';
export { describeDbError, hasAuthoredMessage, type DbErrorDescription } from './db-error-message';
export {
  describeNetworkError,
  isTransportFailure,
  type NetworkErrorDescription,
} from './network-error-message';
export { isUnknownWriteOutcome } from './write-outcome';
export { useReportWriteFailure, type WriteFailureHeadingKey } from './useReportWriteFailure';
