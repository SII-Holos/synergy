import { z } from "zod"

export const COMPUTER_PROTOCOL_VERSION = 1
export const COMPUTER_MAX_MESSAGE_BYTES = 12 * 1024 * 1024
const Ref = z.string().min(1).max(200)
const Pid = z.number().int().positive().max(2_147_483_647)
const WindowId = z.number().int().positive().max(4_294_967_295)
const Point = z.number().finite().min(0).max(32_768)
const observation = { observationId: Ref }

export const ComputerActionSchema = z.discriminatedUnion("action", [
  z
    .object({ ...observation, action: z.literal("click"), elementIndex: z.number().int().nonnegative().max(100_000) })
    .strict(),
  z.object({ ...observation, action: z.literal("point"), x: Point, y: Point }).strict(),
  z.object({ ...observation, action: z.literal("type"), text: z.string().min(1).max(20_000) }).strict(),
  z
    .object({
      ...observation,
      action: z.literal("key"),
      key: z.enum([
        "return",
        "tab",
        "escape",
        "up",
        "down",
        "left",
        "right",
        "space",
        "delete",
        "home",
        "end",
        "pageup",
        "pagedown",
      ]),
    })
    .strict(),
  z
    .object({
      ...observation,
      action: z.literal("scroll"),
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(10).default(3),
    })
    .strict(),
])
export type ComputerAction = z.infer<typeof ComputerActionSchema>

export const ComputerObserveSchema = z.object({ pid: Pid, windowId: WindowId }).strict()
export const ComputerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apps") }).strict(),
  ComputerObserveSchema.extend({ type: z.literal("observe") }),
  z.object({ type: z.literal("action"), input: ComputerActionSchema }).strict(),
  z.object({ type: z.literal("release") }).strict(),
])
export type ComputerCommand = z.infer<typeof ComputerCommandSchema>

export const ComputerResultSchema = z
  .object({
    output: z.string().max(1_000_000),
    observationId: Ref.optional(),
    images: z
      .array(
        z.object({ mimeType: z.enum(["image/png", "image/jpeg"]), data: z.string().max(8 * 1024 * 1024) }).strict(),
      )
      .max(2)
      .default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .meta({ ref: "ComputerResult" })
export type ComputerResult = z.infer<typeof ComputerResultSchema>

export const ComputerHostMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("register"),
      version: z.literal(COMPUTER_PROTOCOL_VERSION),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ type: z.literal("result"), id: Ref, result: ComputerResultSchema }).strict(),
  z
    .object({
      type: z.literal("error"),
      id: Ref,
      message: z.string().max(20_000),
      code: z.string().max(100).optional(),
    })
    .strict(),
])
export const ComputerServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("registered"), version: z.literal(COMPUTER_PROTOCOL_VERSION) }).strict(),
  z.object({ type: z.literal("command"), id: Ref, owner: Ref, command: ComputerCommandSchema }).strict(),
  z.object({ type: z.literal("cancel"), id: Ref }).strict(),
])
export type ComputerServerMessage = z.infer<typeof ComputerServerMessageSchema>

export class ComputerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ComputerError"
  }
}
