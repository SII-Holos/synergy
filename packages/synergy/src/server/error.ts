import { resolver } from "hono-openapi"
import z from "zod"
import { Storage } from "../storage/storage"
import { NoteError } from "../note"

export const BadRequestError = z
  .object({
    data: z.any(),
    errors: z.array(z.record(z.string(), z.any())),
    success: z.literal(false),
  })
  .meta({ ref: "BadRequestError" })

export const ServiceUnavailableError = z
  .object({
    message: z.string(),
  })
  .meta({ ref: "ServiceUnavailableError" })

export const RuntimeShuttingDownError = z
  .object({
    name: z.literal("RuntimeShuttingDown"),
    data: z.object({ message: z.string() }),
  })
  .meta({ ref: "RuntimeShuttingDownError" })

export const ForbiddenError = z
  .object({
    message: z.string(),
  })
  .meta({ ref: "ForbiddenError" })

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(BadRequestError),
      },
    },
  },
  403: {
    description: "Forbidden",
    content: {
      "application/json": {
        schema: resolver(ForbiddenError),
      },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(Storage.NotFoundError.Schema),
      },
    },
  },
  409: {
    description: "Conflict",
    content: {
      "application/json": {
        schema: resolver(NoteError.Conflict.Schema),
      },
    },
  },
  503: {
    description: "Service unavailable or runtime shutting down",
    content: {
      "application/json": {
        schema: resolver(z.union([ServiceUnavailableError, RuntimeShuttingDownError])),
      },
    },
  },
} as const

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
