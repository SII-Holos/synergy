import { z } from "zod"
import { ModelSelection } from "@ericsanchezok/synergy-harness/session/model-selection-schema"
import { SessionContextSnapshot } from "@ericsanchezok/synergy-harness/session/context-snapshot"

export namespace DigitalTwinContract {
  export const Settings = z
    .object({
      automatic: z
        .boolean()
        .optional()
        .describe("Automatically predict the next input after a completed task (default: false)"),
      model: ModelSelection.Model.nullable()
        .optional()
        .describe("Prediction model; null or absent follows the current Session"),
    })
    .strict()
    .meta({ ref: "DigitalTwinSettings" })
  export const Input = z
    .object({
      sessionID: z.string().min(1),
      expected: SessionContextSnapshot.Anchor.optional(),
      requestID: z.string().min(1).max(256),
    })
    .strict()
    .meta({ ref: "DigitalTwinInput" })
  export type Input = z.infer<typeof Input>
  export const Stamp = SessionContextSnapshot.Stamp.omit({ sources: true }).meta({ ref: "DigitalTwinSourceStamp" })
  export const Result = z
    .object({
      proposalID: z.string(),
      candidate: z.string().min(1),
      stamp: Stamp,
    })
    .meta({ ref: "DigitalTwinPrediction" })
  export type Result = z.infer<typeof Result>
  export const Failure = z
    .object({
      code: z.enum(["source_unavailable", "source_changed", "model_unavailable", "cancelled", "invalid_prediction"]),
      message: z.string(),
    })
    .meta({ ref: "DigitalTwinFailure" })
}
