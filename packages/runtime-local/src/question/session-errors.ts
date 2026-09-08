import { SessionQuestionErrors } from "@ericsanchezok/synergy-harness/session/question-errors"
import { Question } from "."

/**
 * S9c source inversion: the L1 session processor classifies rejected
 * interactive questions through the SessionQuestionErrors registry instead
 * of importing the question product domain. Loaded through
 * src/product-registration.ts.
 */
export function registerQuestionSessionErrors() {
  SessionQuestionErrors.registerRejectedError(Question.RejectedError)
}
