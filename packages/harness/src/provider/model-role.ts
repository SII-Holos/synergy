import z from "zod"

export const MODEL_ROLE_IDS = ["vision", "nano", "mini", "mid", "thinking", "long", "creative"] as const

export const ModelRole = z.enum(MODEL_ROLE_IDS).meta({ ref: "ModelRole" })
export type ModelRole = z.infer<typeof ModelRole>

export const MODEL_ROLE_FALLBACK_FIELDS = {
  vision: ["vision_model"],
  nano: ["nano_model", "mini_model", "mid_model", "model"],
  mini: ["mini_model", "mid_model", "model"],
  mid: ["mid_model", "model"],
  thinking: ["thinking_model", "model"],
  long: ["long_context_model", "model"],
  creative: ["creative_model", "model"],
} as const satisfies Record<ModelRole, readonly string[]>
