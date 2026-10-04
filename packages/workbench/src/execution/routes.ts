import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ExecutionSchema } from "./schema"
import { ExecutionService } from "./service"
import { ExecutionContent } from "./content"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"

const Params = z.object({ sessionID: Identifier.schema("session") })
const NodeParams = Params.extend({ nodeID: z.string().min(1).max(4096) })
const ContentQuery = ExecutionContent.Query.extend({
  offset: z.coerce.number().int().nonnegative().safe().default(0),
  limit: z.coerce.number().int().min(1).max(65_536).default(65_536),
})
async function download(source: ExecutionContent.Source, field: string, signal: AbortSignal) {
  const runtime = RuntimeContext.current()
  const scope = ScopeContext.current.scope
  const workspace = ScopeContext.current.workspace
  const iterator = source.stream()[Symbol.asyncIterator]()
  const release = Scope.registerArchiveGuard((id) => {
    if (id === scope.id) throw new Error("Execution content is being read")
  })
  const bind = <T>(fn: () => T | Promise<T>) => runtime.bind(() => ScopeContext.provide({ scope, workspace, fn }))
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const finish = () => {
    if (closed) return
    closed = true
    release()
    signal.removeEventListener("abort", abort)
  }
  const abort = () => {
    if (closed) return
    controller?.error(signal.reason)
    finish()
    void bind(() => iterator.return?.())().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      if (signal.aborted) abort()
    },
    pull: bind(async () => {
      if (closed) return
      try {
        const item = await iterator.next()
        if (closed) return
        if (item.done) {
          finish()
          controller!.close()
          return
        }
        controller!.enqueue(item.value)
      } catch (error) {
        finish()
        controller!.error(error)
      }
    }),
    cancel: bind(async () => {
      finish()
      await iterator.return?.()
    }),
  })
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="execution-${field.replace(/[^a-zA-Z0-9_-]/g, "_")}.${source.mediaType.includes("json") ? "json" : "txt"}"`,
      "Content-Length": String(source.bytes),
      "Cache-Control": "no-store",
      "X-Execution-Content-Version": source.contentVersion,
      "X-Execution-Content-Status": source.status,
      ...(source.sha256 ? { "X-Execution-Content-Sha256": source.sha256 } : {}),
    },
  })
}
const metadata = (operationId: string, summary: string, schema: z.ZodType) =>
  describeRoute({
    operationId,
    summary,
    responses: {
      200: { description: summary, content: { "application/json": { schema: resolver(schema) } } },
      400: { description: "Invalid execution query" },
      404: { description: "Execution evidence was not found in the selected Scope and session" },
    },
  })
async function result<T>(body: () => Promise<T>) {
  try {
    return { status: 200 as const, value: await body() }
  } catch (error) {
    if (error instanceof Storage.NotFoundError) return { status: 404 as const, value: { message: error.message } }
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof RangeError ||
      (error instanceof Error && error.message.includes("cursor"))
    )
      return { status: 400 as const, value: { message: "Invalid execution query" } }
    throw error
  }
}
export const ExecutionRoute = () =>
  new Hono()
    .get(
      "/:sessionID/execution/summary",
      metadata("session.executionSummary", "Read a compact session execution summary", ExecutionSchema.Summary),
      validator("param", Params),
      validator("query", ExecutionSchema.Query.pick({ runID: true })),
      async (c) => {
        const response = await result(() =>
          ExecutionService.summary(c.req.valid("param").sessionID, c.req.valid("query").runID),
        )
        return c.json(response.value, response.status)
      },
    )
    .get(
      "/:sessionID/execution/trajectory",
      metadata("session.executionTrajectory", "Page through session execution records", ExecutionSchema.Page),
      validator("param", Params),
      validator("query", ExecutionSchema.Query),
      async (c) => {
        const response = await result(() =>
          ExecutionService.trajectory(c.req.valid("param").sessionID, c.req.valid("query")),
        )
        return c.json(response.value, response.status)
      },
    )
    .get(
      "/:sessionID/execution/nodes/:nodeID",
      metadata("session.executionNode", "Inspect one session execution record", ExecutionSchema.Detail),
      validator("param", NodeParams),
      validator("query", ExecutionSchema.Query.pick({ runID: true })),
      async (c) => {
        const { sessionID, nodeID } = c.req.valid("param")
        const response = await result(() =>
          ExecutionService.node(sessionID, nodeID, c.req.valid("query").runID, c.req.raw.signal),
        )
        return c.json(response.value, response.status)
      },
    )
    .get(
      "/:sessionID/execution/nodes/:nodeID/content",
      metadata("session.executionContent", "Read a bounded execution content page", ExecutionSchema.Content),
      validator("param", NodeParams),
      validator("query", ContentQuery),
      async (c) => {
        const { sessionID, nodeID } = c.req.valid("param")
        const { field, offset, limit, runID, version } = c.req.valid("query")
        const response = await result(() =>
          ExecutionService.content(sessionID, nodeID, field, offset, limit, runID, version),
        )
        return c.json(response.value, response.status)
      },
    )
    .get(
      "/:sessionID/execution/nodes/:nodeID/content/sections",
      metadata(
        "session.executionContentSections",
        "Read structured execution content sections",
        ExecutionContent.Sections,
      ),
      validator("param", NodeParams),
      validator("query", ExecutionContent.PageQuery),
      async (c) => {
        const { sessionID, nodeID } = c.req.valid("param")
        const input = c.req.valid("query")
        const response = await result(async () =>
          ExecutionContent.sections(
            await ExecutionService.contentSource(sessionID, nodeID, input.field, input.runID, input.version),
            input,
            c.req.raw.signal,
          ),
        )
        return c.json(response.value, response.status)
      },
    )
    .get(
      "/:sessionID/execution/nodes/:nodeID/content/search",
      metadata(
        "session.executionContentSearch",
        "Search an entire version of execution content",
        ExecutionContent.Search,
      ),
      validator("param", NodeParams),
      validator("query", ExecutionContent.SearchQuery),
      async (c) => {
        const { sessionID, nodeID } = c.req.valid("param")
        const input = c.req.valid("query")
        const response = await result(async () =>
          ExecutionContent.search(
            await ExecutionService.contentSource(sessionID, nodeID, input.field, input.runID, input.version),
            input,
            c.req.raw.signal,
          ),
        )
        return c.json(response.value, response.status)
      },
    )
    .get(
      "/:sessionID/execution/nodes/:nodeID/content/download",
      describeRoute({
        operationId: "session.executionContentDownload",
        summary: "Download complete execution content at a fixed version",
        responses: {
          200: {
            description: "Verified execution content",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          400: { description: "Invalid execution content query or version" },
          404: { description: "Execution content was not found" },
        },
      }),
      validator("param", NodeParams),
      validator("query", ExecutionContent.Query),
      async (c) => {
        const { sessionID, nodeID } = c.req.valid("param")
        const input = c.req.valid("query")
        const response = await result(async () =>
          download(
            await ExecutionService.contentSource(sessionID, nodeID, input.field, input.runID, input.version),
            input.field,
            c.req.raw.signal,
          ),
        )
        return response.status === 200 ? response.value : c.json(response.value, response.status)
      },
    )
