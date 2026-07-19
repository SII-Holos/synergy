import { Bus } from "@/bus"
import { ScopeContext } from "@/scope/context"
import { Dag } from "@/session/dag"
import { SessionInbox } from "@/session/inbox"
import { SessionManager } from "@/session/manager"
import { Todo } from "@/session/todo"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { errors } from "./error"

const SessionVolatileState = z
  .object({
    inbox: SessionInbox.Item.array(),
    todo: Todo.Info.array(),
    dag: Dag.Node.array(),
  })
  .meta({ ref: "SessionVolatileState" })

const SessionVolatileError = z
  .object({
    code: z.enum(["SESSION_NOT_FOUND", "SESSION_ARCHIVED", "RESOURCE_FAILED"]),
    message: z.string(),
  })
  .meta({ ref: "SessionVolatileError" })

export const SessionVolatileBatchInput = z
  .object({
    sessionIDs: z.array(z.string()).max(50),
  })
  .meta({ ref: "SessionVolatileBatchInput" })

export const SessionVolatileBatchResponse = z
  .object({
    sessions: z.record(z.string(), SessionVolatileState),
    errors: z.record(z.string(), SessionVolatileError).optional(),
  })
  .meta({ ref: "SessionVolatileBatchResponse" })

type VolatileResult =
  | { sessionID: string; state: z.infer<typeof SessionVolatileState> }
  | { sessionID: string; error: z.infer<typeof SessionVolatileError> }

async function loadSessionVolatileState(sessionID: string): Promise<VolatileResult> {
  const session = await SessionManager.getSession(sessionID)
  if (!session || session.scope.id !== ScopeContext.current.scope.id) {
    return { sessionID, error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }
  }
  if (session.time.archived) {
    return { sessionID, error: { code: "SESSION_ARCHIVED", message: "Session archived" } }
  }
  try {
    const [inbox, todo, dag] = await Promise.all([
      SessionInbox.list(sessionID),
      Todo.get(sessionID),
      Dag.get(sessionID),
    ])
    return { sessionID, state: { inbox, todo, dag } }
  } catch {
    return { sessionID, error: { code: "RESOURCE_FAILED", message: "Failed to load session state" } }
  }
}

export const SessionVolatileBatchRoute = new Hono().post(
  "/batch/volatile",
  describeRoute({
    summary: "Batch session volatile state",
    description: "Retrieve inbox, todo, and DAG state for multiple sessions in the current scope.",
    operationId: "session.volatileBatch",
    responses: {
      200: {
        description: "Session volatile state by session ID",
        content: {
          "application/json": {
            schema: resolver(SessionVolatileBatchResponse),
          },
        },
      },
      ...errors(400),
    },
  }),
  validator("json", SessionVolatileBatchInput),
  async (c) => {
    const stampSeq = Bus.currentSeq()
    const stampEpoch = Bus.epoch()
    const sessionIDs = [...new Set(c.req.valid("json").sessionIDs)]
    const results = await Promise.all(sessionIDs.map(loadSessionVolatileState))
    const sessions: Record<string, z.infer<typeof SessionVolatileState>> = {}
    const batchErrors: Record<string, z.infer<typeof SessionVolatileError>> = {}
    for (const result of results) {
      if ("state" in result) sessions[result.sessionID] = result.state
      else batchErrors[result.sessionID] = result.error
    }
    c.header("x-synergy-seq", String(stampSeq))
    c.header("x-synergy-epoch", stampEpoch)
    return c.json({
      sessions,
      ...(Object.keys(batchErrors).length > 0 ? { errors: batchErrors } : {}),
    })
  },
)
