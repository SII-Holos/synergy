import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { SessionExport } from "../session/session-export"
import { SessionImport } from "../session/session-import"

export const SessionExportRoute = new Hono()
  .get(
    "/:sessionID/export/estimate",
    describeRoute({
      summary: "Estimate session export size",
      description: "Estimate the size of a session export for a session and its subsessions.",
      operationId: "session.export.estimate",
      responses: {
        200: {
          description: "Size estimate",
          content: {
            "application/json": {
              schema: resolver(SessionExport.SizeEstimate),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Root session ID" }),
      }),
    ),
    async (c) => {
      const { sessionID } = c.req.valid("param")
      const estimate = await SessionExport.estimate(sessionID)
      return c.json(estimate)
    },
  )
  .get(
    "/:sessionID/export",
    describeRoute({
      summary: "Export session data",
      description: "Generate and download exported session data for a session and all its subsessions.",
      operationId: "session.export.download",
      responses: {
        200: { description: "Session export as gzipped JSON" },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Root session ID" }),
      }),
    ),
    validator(
      "query",
      z.object({
        mode: SessionExport.Mode.default("standard").meta({ description: "Export detail level" }),
      }),
    ),
    async (c) => {
      const { sessionID } = c.req.valid("param")
      const { mode } = c.req.valid("query")
      const report = await SessionExport.generate({ sessionID, mode })
      const json = JSON.stringify(report)
      const compressed = Bun.gzipSync(Buffer.from(json))
      const safeTitle = report.sessions[0]?.info.title.replace(/[^\w\s-]/g, "").trim() || "session"
      const filename = `session-export-${safeTitle}-${Date.now()}.json.gz`
      return c.body(compressed, 200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Encoding": "identity",
      })
    },
  )
  .post(
    "/import",
    describeRoute({
      summary: "Import session data",
      description: "Import a Synergy session export JSON or gzipped JSON file into the current scope.",
      operationId: "session.import",
      responses: {
        200: {
          description: "Imported session data",
          content: {
            "application/json": {
              schema: resolver(SessionImport.Result),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("form", z.object({ file: z.any() })),
    async (c) => {
      const { file } = c.req.valid("form")
      if (!(file instanceof File)) return c.json({ message: "Missing file field" }, 400)
      try {
        const result = await SessionImport.fromBuffer(await file.arrayBuffer())
        return c.json(result)
      } catch (error) {
        return c.json({ message: error instanceof Error ? error.message : String(error) }, 400)
      }
    },
  )
