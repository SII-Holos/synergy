import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Identifier } from "../id/id"
import { errors } from "./error"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { Info as BlueprintLoopInfoSchema } from "../blueprint/types"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { NoteStore } from "../note"
import { Log } from "../util/log"

const log = Log.create({ service: "server.blueprint" })

const CreateInput = z
  .object({
    noteID: z.string().meta({ description: "Note ID to loop" }),
    noteVersion: z.number().optional().meta({ description: "Note version to lock" }),
    title: z.string().meta({ description: "Loop title" }),
    description: z.string().optional().meta({ description: "Loop description" }),
    sessionID: z.string().meta({ description: "Session ID driving this loop" }),
    runMode: z.enum(["current", "new", "worktree"]).optional().meta({ description: "Loop run mode (default current)" }),
    parentSessionID: z.string().optional().meta({ description: "Parent session ID" }),
    firstPrompt: z.string().optional().meta({ description: "First user prompt for the loop" }),
    loopIndex: z.number().optional().meta({ description: "Zero-based loop index" }),
  })
  .meta({ ref: "BlueprintLoopCreateInput" })

const CODING_BLUEPRINT_AGENTS = new Set(["synergy-max", "developer", "implementation-engineer", "refactoring-engineer"])

function isCodingBlueprintAgent(agentName?: string): boolean {
  return !!agentName && CODING_BLUEPRINT_AGENTS.has(agentName)
}

async function knownAgentName(agentName?: string): Promise<string | undefined> {
  const trimmed = agentName?.trim()
  if (!trimmed) return undefined
  const agent = await Agent.get(trimmed).catch(() => undefined)
  return agent?.name
}

async function resolveBlueprintAgent(sessionID: string, noteID: string): Promise<string | undefined> {
  const note = await NoteStore.getAny(ScopeContext.current.scope.id, noteID).catch(() => undefined)
  const noteAgent = await knownAgentName(note?.blueprint?.defaultAgent)
  if (noteAgent) return noteAgent

  const messages = await Session.messages({ sessionID, raw: true }).catch(() => [])
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.info.role !== "user") continue
    const messageAgent = await knownAgentName(message.info.agent)
    if (messageAgent) return messageAgent
  }

  return Agent.defaultAgent()
    .then(knownAgentName)
    .catch(() => undefined)
}

async function resolveBlueprintAuditAgent(noteID: string): Promise<string> {
  const note = await NoteStore.getAny(ScopeContext.current.scope.id, noteID).catch(() => undefined)
  const noteAgent = await knownAgentName(note?.blueprint?.auditAgent)
  return noteAgent ?? "supervisor"
}
function normalizeBlueprintStartUserPrompt(userPrompt?: string): string | undefined {
  const trimmed = userPrompt?.trim()
  return trimmed ? trimmed : undefined
}

function defaultFirstPrompt(loop: { id: string; title: string; noteID: string }, agentName?: string) {
  if (isCodingBlueprintAgent(agentName)) {
    return `Execute the coding Blueprint "${loop.title}" (note ID: ${loop.noteID}, loop ID: ${loop.id}).
First call note_read with ids=["${loop.noteID}"] and read the full Blueprint content.
Treat the Blueprint as the authoritative engineering contract for this run: requirements, non-goals, codebase entry points, migration or compatibility expectations, cleanup, and verification commands.
Create or update a DAG when the work has multiple phases, dependencies, parallel implementation slices, or review gates. Split independent code work by module or concern and keep each delegated task narrow.
Continue until every Blueprint requirement is implemented, verified, and integrated. Keep the codebase clean: remove obsolete paths when the Blueprint replaces them, avoid redundant logic, and preserve local conventions.
When the Blueprint is ready for audit, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).
If the task is blocked beyond recovery, call blueprint_loop_finish({ loopID: "${loop.id}", status: "failed", summary: "..." }).`
  }

  return `Execute the Blueprint "${loop.title}" (note ID: ${loop.noteID}, loop ID: ${loop.id}).
First call note_read with ids=["${loop.noteID}"] and read the full Blueprint content.
Treat the Blueprint as the authoritative brief for this run: goal, deliverables, constraints, audience, chosen approach, quality criteria, and acceptance criteria.
Choose the execution shape that fits the Blueprint's domain and complexity. Work directly for small linear tasks; create or update a DAG when there are multiple phases, real dependencies, parallel workstreams, or useful progress checkpoints.
Use domain-appropriate specialists when they improve the outcome. Do not import software-engineering workflow unless the Blueprint is software work.
Continue until the requested outcome is complete. For every material requirement, produce or update the requested artifact or result, keep the whole deliverable coherent, and apply quality checks appropriate to the domain.
When the Blueprint is ready for audit, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).
If the task is blocked beyond recovery, call blueprint_loop_finish({ loopID: "${loop.id}", status: "failed", summary: "..." }).`
}

async function bindSessionToLoop(sessionID: string, loopID: string, loopRole: "execution" | "audit") {
  await Session.update(sessionID, (draft) => {
    draft.blueprint = { ...draft.blueprint, loopID, loopRole }
  })
}

async function assertLoopSessionInCurrentScope(sessionID: string) {
  const session = await Session.get(sessionID)
  const sessionScopeID = session.scope.id
  const loopScopeID = ScopeContext.current.scope.id
  if (sessionScopeID !== loopScopeID) {
    throw new Error(
      `Session ${sessionID} belongs to scope ${sessionScopeID}, but this BlueprintLoop is in ${loopScopeID}.`,
    )
  }
}

async function deliverFirstPrompt(
  sessionID: string,
  loop: { id: string; noteID: string; title: string; firstPrompt?: string; executionAgent?: string },
  userPrompt?: string,
) {
  const agentName = loop.executionAgent ?? (await resolveBlueprintAgent(sessionID, loop.noteID))
  let text = loop.firstPrompt?.trim() || defaultFirstPrompt(loop, agentName)
  if (userPrompt) {
    text += `\n\nUser instruction:\n${userPrompt}`
  }
  const textPart: MessageV2.TextPart = {
    id: Identifier.ascending("part"),
    sessionID,
    messageID: Identifier.ascending("message"),
    type: "text",
    text,
  }
  const mail: SessionManager.SessionMail.User = {
    type: "user",
    parts: [textPart],
    ...(agentName ? { agent: agentName } : {}),
    summary: {
      title: `Execute ${loop.title} blueprint`,
    },
    metadata: {
      source: "blueprint_loop_start",
      loopID: loop.id,
      noteID: loop.noteID,
      title: loop.title,
      ...(agentName ? { agent: agentName } : {}),
      ...(userPrompt ? { userPrompt } : {}),
    },
  }
  await SessionManager.deliver({ target: sessionID, mail })
}

export const BlueprintRoute = new Hono()
  .get(
    "/loop",
    describeRoute({
      summary: "List BlueprintLoops",
      description: "List all BlueprintLoops for the current scope.",
      operationId: "blueprint.loop.list",
      responses: {
        200: {
          description: "List of BlueprintLoops",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const loops = await BlueprintLoopStore.list(ScopeContext.current.scope.id)
        return c.json(loops)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop",
    describeRoute({
      summary: "Create BlueprintLoop",
      description: "Create a new BlueprintLoop in the current scope. Returns armed status.",
      operationId: "blueprint.loop.create",
      responses: {
        200: {
          description: "Created BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400),
      },
    }),
    validator("json", CreateInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        await assertLoopSessionInCurrentScope(body.sessionID)
        const [executionAgent, auditAgent] = await Promise.all([
          resolveBlueprintAgent(body.sessionID, body.noteID),
          resolveBlueprintAuditAgent(body.noteID),
        ])
        const loop = await BlueprintLoopStore.create({
          ...body,
          executionAgent,
          auditAgent,
          runMode: body.runMode ?? "current",
        })
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof LoopError.AlreadyActive) {
          return c.json({ message: "This Blueprint already has an active run.", data: err.data }, 400)
        }
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/complete",
    describeRoute({
      summary: "Complete BlueprintLoop",
      description: "Mark a BlueprintLoop as completed.",
      operationId: "blueprint.loop.complete",
      responses: {
        200: {
          description: "Completed BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.complete(ScopeContext.current.scope.id, id)
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/cancel",
    describeRoute({
      summary: "Cancel BlueprintLoop",
      description: "Cancel a BlueprintLoop.",
      operationId: "blueprint.loop.cancel",
      responses: {
        200: {
          description: "Cancelled BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, { status: "cancelled" })
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/loop/:id",
    describeRoute({
      summary: "Get BlueprintLoop",
      description: "Get a specific BlueprintLoop by ID.",
      operationId: "blueprint.loop.get",
      responses: {
        200: {
          description: "BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, id)
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .put(
    "/loop/:id/bind",
    describeRoute({
      summary: "Bind session to BlueprintLoop",
      description: "Bind the current session to a BlueprintLoop so the session drives loop execution.",
      operationId: "blueprint.loop.bind",
      responses: {
        200: {
          description: "Updated BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    validator("json", z.object({ sessionID: z.string().meta({ description: "Session ID to bind" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const { sessionID } = c.req.valid("json")
        const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, id)
        await bindSessionToLoop(sessionID, id, "execution")
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/start",
    describeRoute({
      summary: "Start BlueprintLoop (armed → running)",
      description: "Transition a BlueprintLoop from armed to running.",
      operationId: "blueprint.loop.start",
      responses: {
        200: {
          description: "Started BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    validator(
      "json",
      z
        .object({
          userPrompt: z
            .string()
            .optional()
            .meta({ description: "User-provided prompt to merge into execution start message" }),
        })
        .optional(),
    ),
    async (c) => {
      const id = c.req.valid("param").id
      let started = false
      try {
        const body = c.req.valid("json")
        const userPrompt = normalizeBlueprintStartUserPrompt(body?.userPrompt)
        const before = await BlueprintLoopStore.get(ScopeContext.current.scope.id, id)
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, {
          status: "running",
          userPrompt: userPrompt ?? null,
        })
        started = true
        await bindSessionToLoop(before.sessionID, id, "execution")
        const scopeID = ScopeContext.current.scope.id
        void deliverFirstPrompt(before.sessionID, before, userPrompt).catch((err) => {
          log.error("failed to deliver BlueprintLoop start prompt", { loopID: id, error: err })
          BlueprintLoopStore.updateStatus(scopeID, id, {
            status: "failed",
            error: err?.message ?? String(err),
          }).catch(() => undefined)
        })
        return c.json(loop)
      } catch (err: any) {
        if (started) {
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, {
            status: "failed",
            error: err?.message ?? String(err),
          }).catch(() => undefined)
        }
        if (err instanceof Storage.NotFoundError) return c.json({ message: `BlueprintLoop not found: ${id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/wait",
    describeRoute({
      summary: "Wait BlueprintLoop (running → waiting)",
      description: "Transition a BlueprintLoop from running to waiting.",
      operationId: "blueprint.loop.wait",
      responses: {
        200: {
          description: "Waiting BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, { status: "waiting" })
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/resume",
    describeRoute({
      summary: "Resume BlueprintLoop (waiting → running)",
      description: "Transition a BlueprintLoop from waiting back to running.",
      operationId: "blueprint.loop.resume",
      responses: {
        200: {
          description: "Resumed BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, { status: "running" })
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/loop/:id/activity",
    describeRoute({
      summary: "Get BlueprintLoop activity",
      description: "Get derived activity metrics for a BlueprintLoop (derived from session state).",
      operationId: "blueprint.loop.activity",
      responses: {
        200: {
          description: "Activity summary",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    stepCount: z.number(),
                    messageCount: z.number(),
                    lastActivityAt: z.number().optional(),
                  })
                  .meta({ ref: "BlueprintLoopActivity" }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        await BlueprintLoopStore.get(ScopeContext.current.scope.id, c.req.valid("param").id)
        // Activity is derived from session state — not persistently stored.
        // Return zeros safely; full derivation endpoint later.
        return c.json({
          stepCount: 0,
          messageCount: 0,
          lastActivityAt: undefined,
        })
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .put(
    "/session/:id/plan-mode",
    describeRoute({
      summary: "Toggle Plan Mode",
      description: "Enable or disable Plan Mode on a session.",
      operationId: "blueprint.session.planMode",
      responses: {
        200: {
          description: "Updated session",
          content: { "application/json": { schema: resolver(Session.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    validator("json", z.object({ planMode: z.boolean().meta({ description: "Enable or disable Plan Mode" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const { planMode } = c.req.valid("json")
        const session = await Session.update(id, (draft) => {
          draft.blueprint = { ...draft.blueprint, planMode }
        })
        return c.json(session)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
