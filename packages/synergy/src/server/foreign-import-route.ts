import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { ForeignImport } from "../session/import/foreign-import"

/**
 * Foreign session import routes.
 *
 * - `POST /session/import/foreign` — upload a single transcript (Claude Code
 *   or Codex jsonl) and import it into the current scope. On failure, every
 *   session created by the attempt is rolled back.
 * - `GET  /session/import/foreign/scan` — list candidate transcripts under
 *   the default (or a custom) directory, with titles and sizes.
 * - `POST /session/import/foreign/jobs` — start a server-owned batch import
 *   job over selected transcripts; the frontend polls `.../jobs/current`.
 * - `GET  /session/import/foreign/jobs/current` — current job with progress.
 * - `POST /session/import/foreign/jobs/current/cancel` — cancel a running job.
 */

export const ForeignImportSource = z.enum(["claude-code", "codex"]).meta({ ref: "ForeignImportSource" })
export type ForeignImportSource = z.infer<typeof ForeignImportSource>

const ForeignImportStats = z
  .object({
    skippedLines: z.number(),
    unknownTypes: z.number(),
    warnings: z.array(z.string()),
  })
  .meta({ ref: "ForeignImportStats" })

const ForeignImportCandidate = z
  .object({
    source: ForeignImportSource,
    path: z.string(),
    title: z.string(),
    created: z.number(),
    updated: z.number(),
    sizeBytes: z.number(),
    sidechain: z.boolean(),
  })
  .meta({ ref: "ForeignImportCandidate" })

const ForeignImportScanResult = z
  .object({
    source: ForeignImportSource,
    root: z.string(),
    candidates: z.array(ForeignImportCandidate),
  })
  .meta({ ref: "ForeignImportScanResult" })

const ForeignImportSingleResult = z
  .object({
    rootSessionID: z.string(),
    sessionCount: z.number(),
    messageCount: z.number(),
    warnings: z.array(z.string()),
    stats: ForeignImportStats,
  })
  .meta({ ref: "ForeignImportSingleResult" })

const ForeignImportJobItem = z
  .object({
    path: z.string(),
    status: z.enum(["pending", "running", "ok", "failed"]),
    title: z.string().optional(),
    sessionID: z.string().optional(),
    error: z.string().optional(),
  })
  .meta({ ref: "ForeignImportJobItem" })

const ForeignImportJobState = z
  .object({
    id: z.string(),
    source: ForeignImportSource,
    status: z.enum(["running", "completed", "cancelled", "failed"]),
    totalCount: z.number(),
    completedCount: z.number(),
    okCount: z.number(),
    failedCount: z.number(),
    startedAt: z.number(),
    completedAt: z.number().nullable(),
    error: z.string().nullable(),
    items: z.array(ForeignImportJobItem),
  })
  .meta({ ref: "ForeignImportJobState" })

const ForeignImportJobSummary = ForeignImportJobState.omit({ items: true }).meta({
  ref: "ForeignImportJobSummary",
})

const ForeignImportJobInput = z
  .object({
    source: ForeignImportSource,
    paths: z.array(z.string()).min(1).max(1000),
    includeSidechains: z.boolean().optional(),
    includeThinking: z.boolean().optional(),
  })
  .meta({ ref: "ForeignImportJobInput" })

const ForeignImportError = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .meta({ ref: "ForeignImportError" })

const ForeignImportConflict = ForeignImportError.extend({ job: ForeignImportJobSummary }).meta({
  ref: "ForeignImportConflict",
})

export const ForeignImportRoute = new Hono()
  .post(
    "/import/foreign",
    describeRoute({
      summary: "Import a Claude Code or Codex transcript",
      description:
        "Parse a single Claude Code or Codex CLI jsonl transcript and import it into the current scope as a Synergy session. Any sessions created by a failed attempt are rolled back.",
      operationId: "session.importForeign",
      responses: {
        200: {
          description: "Imported session result",
          content: { "application/json": { schema: resolver(ForeignImportSingleResult) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "form",
      z.object({
        source: ForeignImportSource,
        file: z.any(),
        includeSidechains: z.string().optional(),
        includeThinking: z.string().optional(),
      }),
    ),
    async (c) => {
      const form = c.req.valid("form")
      if (!(form.file instanceof File)) {
        return c.json({ code: "MISSING_FILE", message: "Missing file field" }, 400)
      }
      const text = await form.file.text()
      try {
        const { result, stats } = await ForeignImport.importText(form.source, text, {
          includeSidechains: form.includeSidechains === "true",
          includeThinking: form.includeThinking === "true",
        })
        return c.json({
          rootSessionID: result.rootSessionID,
          sessionCount: result.sessionCount,
          messageCount: result.messageCount,
          warnings: result.warnings,
          stats,
        })
      } catch (error) {
        return c.json({ code: "IMPORT_FAILED", message: error instanceof Error ? error.message : String(error) }, 400)
      }
    },
  )
  .get(
    "/import/foreign/scan",
    describeRoute({
      summary: "Scan for Claude Code or Codex transcripts",
      description:
        "List candidate transcript jsonl files under the default home directory (or a custom directory) for a source.",
      operationId: "session.scanForeign",
      responses: {
        200: {
          description: "Scan result with candidates",
          content: { "application/json": { schema: resolver(ForeignImportScanResult) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "query",
      z.object({
        source: ForeignImportSource,
        dir: z.string().optional(),
      }),
    ),
    async (c) => {
      const { source, dir } = c.req.valid("query")
      const candidates = await ForeignImport.scanCandidates(source, dir)
      return c.json({
        source,
        root: dir ?? ForeignImport.defaultRoot(source),
        candidates,
      })
    },
  )
  .post(
    "/import/foreign/jobs",
    describeRoute({
      summary: "Start a batch foreign session import job",
      description:
        "Create a server-owned batch import job over the given transcript paths and return its initial state with durable aggregate progress.",
      operationId: "session.startForeignImportJob",
      responses: {
        200: {
          description: "Foreign import job summary",
          content: { "application/json": { schema: resolver(ForeignImportJobSummary) } },
        },
        409: {
          description: "A foreign import job is already running",
          content: { "application/json": { schema: resolver(ForeignImportConflict) } },
        },
        ...errors(400),
      },
    }),
    validator("json", ForeignImportJobInput),
    async (c) => {
      const input = c.req.valid("json")
      try {
        return c.json(ForeignImport.start(input))
      } catch (error) {
        const current = ForeignImport.currentSummary()
        if (current?.status === "running") {
          return c.json(
            {
              code: "FOREIGN_IMPORT_JOB_ALREADY_RUNNING",
              message: "A foreign session import job is already running",
              job: current,
            },
            409,
          )
        }
        throw error
      }
    },
  )
  .get(
    "/import/foreign/jobs/current",
    describeRoute({
      summary: "Get the current foreign import job",
      description: "Return the most recently created foreign import job with durable aggregate progress.",
      operationId: "session.getForeignImportJob",
      responses: {
        200: {
          description: "Current foreign import job state",
          content: { "application/json": { schema: resolver(ForeignImportJobState) } },
        },
        404: {
          description: "No foreign import job exists",
          content: { "application/json": { schema: resolver(ForeignImportError) } },
        },
      },
    }),
    async (c) => {
      const current = ForeignImport.current()
      if (!current) {
        return c.json({ code: "FOREIGN_IMPORT_JOB_NOT_FOUND", message: "No foreign import job exists" }, 404)
      }
      return c.json(current)
    },
  )
  .post(
    "/import/foreign/jobs/current/cancel",
    describeRoute({
      summary: "Cancel the current foreign import job",
      description: "Cancel the active foreign import job without discarding completed sessions.",
      operationId: "session.cancelForeignImportJob",
      responses: {
        200: {
          description: "Cancelled foreign import job state",
          content: { "application/json": { schema: resolver(ForeignImportJobState) } },
        },
        404: {
          description: "No foreign import job exists",
          content: { "application/json": { schema: resolver(ForeignImportError) } },
        },
        409: {
          description: "The current job is not running",
          content: { "application/json": { schema: resolver(ForeignImportConflict) } },
        },
      },
    }),
    async (c) => {
      const current = ForeignImport.current()
      if (!current) {
        return c.json({ code: "FOREIGN_IMPORT_JOB_NOT_FOUND", message: "No foreign import job exists" }, 404)
      }
      if (current.status !== "running") {
        return c.json(
          {
            code: "FOREIGN_IMPORT_JOB_NOT_RUNNING",
            message: "The current foreign import job is not running",
            job: ForeignImport.currentSummary(),
          },
          409,
        )
      }
      try {
        return c.json(await ForeignImport.cancel(current.id))
      } catch (error) {
        return c.json(
          { code: "FOREIGN_IMPORT_CANCEL_FAILED", message: error instanceof Error ? error.message : String(error) },
          400,
        )
      }
    },
  )
