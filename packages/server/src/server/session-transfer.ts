import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { SessionTransfer } from "@ericsanchezok/synergy-harness/session/transfer"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { errors } from "./error"

const Params = z.object({ sessionID: z.string() })
const Migration = z.object({ migrationID: z.string().uuid() })
const metadata = (method: string, schema: z.ZodType) =>
  describeRoute({
    summary: `Session transfer ${method}`,
    operationId: `sessionTransfer.${method}`,
    responses: {
      200: { description: "Session transfer result", content: { "application/json": { schema: resolver(schema) } } },
      ...errors(400, 404, 409, 503),
    },
  })
async function result(c: Context, action: () => Promise<unknown>) {
  try {
    return c.json(await action())
  } catch (error) {
    if (
      error instanceof Storage.NotFoundError ||
      error instanceof Storage.UnavailableError ||
      error instanceof Storage.BusyError
    )
      throw error
    if (error instanceof SessionTransfer.Rejected || error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ name: "SessionTransferRejected", data: { message: error.message } }, 409)
    throw error
  }
}
async function own(sessionID: string) {
  const session = await Session.get(sessionID)
  if (session.scope.id !== ScopeContext.current.scope.id)
    throw new SessionTransfer.Rejected({ message: "Session transfer belongs to another Scope" })
}

export const SessionTransferRoute = () =>
  new Hono()
    .get("/host", metadata("host", SessionTransfer.Host), (c) => result(c, () => SessionTransfer.host()))
    .post("/stage", metadata("stage", SessionTransfer.Receipt), validator("form", z.object({ file: z.file() })), (c) =>
      result(c, () => SessionTransfer.stage(c.req.valid("form").file)),
    )
    .post(
      "/activate",
      metadata("activate", SessionTransfer.Receipt),
      validator("json", SessionTransfer.Activation),
      (c) => result(c, () => SessionTransfer.activate(c.req.valid("json"))),
    )
    .get(
      "/destination/:migrationID",
      metadata("destination", SessionTransfer.Receipt),
      validator("param", Migration),
      (c) => result(c, () => SessionTransfer.destination(c.req.valid("param").migrationID)),
    )
    .post(
      "/destination/:migrationID/discard",
      metadata("discard", z.boolean()),
      validator("param", Migration),
      validator("json", SessionTransfer.Cancellation),
      (c) =>
        result(c, async () => {
          const proof = c.req.valid("json")
          if (proof.migrationID !== c.req.valid("param").migrationID)
            throw new SessionTransfer.Rejected({ message: "Cancellation identity does not match" })
          return SessionTransfer.discard(proof)
        }),
    )
    .get("/:sessionID", metadata("status", SessionTransfer.State.nullable()), validator("param", Params), (c) =>
      result(c, async () => {
        const { sessionID } = c.req.valid("param")
        await own(sessionID)
        return (await SessionTransfer.status(sessionID)) ?? null
      }),
    )
    .post(
      "/:sessionID/prepare",
      metadata("prepare", SessionTransfer.State),
      validator("param", Params),
      validator("json", SessionTransfer.Prepare),
      (c) =>
        result(c, async () => {
          const { sessionID } = c.req.valid("param")
          await own(sessionID)
          return SessionTransfer.prepare(sessionID, c.req.valid("json"))
        }),
    )
    .get(
      "/:sessionID/archive",
      describeRoute({
        summary: "Download frozen Session transfer",
        operationId: "sessionTransfer.archive",
        responses: {
          200: {
            description: "Validated Session transfer ZIP",
            content: { "application/zip": { schema: { type: "string", format: "binary" } } },
          },
          ...errors(404, 409),
        },
      }),
      validator("param", Params),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        await own(sessionID)
        const blob = await SessionTransfer.archive(sessionID)
        return c.body(blob.stream(), 200, { "Content-Type": "application/zip", "Content-Encoding": "identity" })
      },
    )
    .post(
      "/:sessionID/commit",
      metadata("commit", SessionTransfer.Activation),
      validator("param", Params),
      validator("json", SessionTransfer.Receipt),
      (c) =>
        result(c, async () => {
          const { sessionID } = c.req.valid("param")
          await own(sessionID)
          return SessionTransfer.commit(sessionID, c.req.valid("json"))
        }),
    )
    .post(
      "/:sessionID/complete",
      metadata("complete", SessionTransfer.State.nullable()),
      validator("param", Params),
      validator("json", SessionTransfer.Receipt),
      (c) =>
        result(c, async () => {
          const { sessionID } = c.req.valid("param")
          await own(sessionID)
          return SessionTransfer.complete(sessionID, c.req.valid("json"))
        }),
    )
    .post("/:sessionID/cancel", metadata("cancel", SessionTransfer.Cancellation), validator("param", Params), (c) =>
      result(c, async () => {
        const { sessionID } = c.req.valid("param")
        await own(sessionID)
        return SessionTransfer.cancel(sessionID)
      }),
    )
