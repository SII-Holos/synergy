import { z } from "zod"

import { ComputerObservationSchema } from "./observation.js"
export { ComputerObservationSchema, type ComputerObservation } from "./observation.js"

export const COMPUTER_PROTOCOL_VERSION = 3
export const COMPUTER_MAX_MESSAGE_BYTES = 12 * 1024 * 1024
const Ref = z.string().min(1).max(200)
const Pid = z.number().int().positive().max(2_147_483_647)
const WindowId = z.number().int().positive().max(4_294_967_295)
const Point = z.number().finite().min(0).max(32_768)
const Coordinates = z.object({ x: Point, y: Point }).strict()
const Element = z.object({ elementIndex: z.number().int().nonnegative().max(100_000) }).strict()
const Target = z.union([Element, Coordinates])
const observation = { observationId: Ref }
const delivery = { ...observation, foreground: z.boolean().optional() }

export const ComputerActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...delivery,
      action: z.literal("click"),
      target: Target,
      button: z.enum(["left", "right", "middle"]).optional(),
      count: z.union([z.literal(1), z.literal(2)]).optional(),
    })
    .strict(),
  z.object({ ...delivery, action: z.literal("type"), target: Target, text: z.string().min(1).max(20_000) }).strict(),
  z
    .object({
      ...delivery,
      action: z.literal("key"),
      key: z.string().trim().min(1).max(50),
      modifiers: z
        .array(z.enum(["cmd", "ctrl", "alt", "shift"]))
        .min(1)
        .max(4)
        .optional(),
      target: Target.optional(),
    })
    .strict(),
  z
    .object({
      ...delivery,
      action: z.literal("scroll"),
      target: Target.optional(),
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(10).default(3),
    })
    .strict(),
  z
    .object({
      ...delivery,
      action: z.literal("drag"),
      from: Coordinates,
      to: Coordinates,
      durationSeconds: z.number().finite().min(0.1).max(10).optional(),
    })
    .strict(),
  z.object({ ...observation, action: z.literal("set_value"), target: Element, value: z.string().max(20_000) }).strict(),
])
export type ComputerAction = z.infer<typeof ComputerActionSchema>

export function computerActionPoints(action: ComputerAction) {
  if (action.action === "drag") return [action.from, action.to]
  return action.target && "x" in action.target ? [action.target] : []
}

export const ComputerAppsSchema = z.object({ query: z.string().trim().min(1).max(200).optional() }).strict()
export const ComputerObserveSchema = z
  .object({
    pid: Pid,
    windowId: WindowId,
    query: z.string().trim().min(1).max(200).optional(),
    foreground: z.boolean().optional(),
  })
  .strict()
export const ComputerCommandSchema = z.discriminatedUnion("type", [
  ComputerAppsSchema.extend({ type: z.literal("apps") }),
  ComputerObserveSchema.extend({ type: z.literal("observe") }),
  z
    .object({
      type: z.literal("action"),
      input: ComputerActionSchema,
      imageReceipt: z
        .object({ sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128), callID: Ref })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("release") }).strict(),
])
export type ComputerCommand = z.infer<typeof ComputerCommandSchema>

export const ComputerResultSchema = z
  .object({
    output: z.string().max(1_000_000),
    observationId: Ref.optional(),
    observation: ComputerObservationSchema.optional(),
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
