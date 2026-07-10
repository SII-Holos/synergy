import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export namespace WorkflowError {
  export const RunNotFound = NamedError.create("WorkflowRunNotFound", z.object({ runID: z.string() }))

  export const CharterNotFound = NamedError.create(
    "WorkflowCharterNotFound",
    z.object({ charterID: z.string(), version: z.number().optional() }),
  )

  export const CharterInvalid = NamedError.create("WorkflowCharterInvalid", z.object({ errors: z.array(z.string()) }))

  export const TransitionRejected = NamedError.create("WorkflowTransitionRejected", z.object({ reason: z.string() }))

  export const NotAuthorized = NamedError.create("WorkflowNotAuthorized", z.object({ reason: z.string() }))
}
