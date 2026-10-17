import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { requestWithinLimit } from "@ericsanchezok/synergy-server/server/request-body-limit"
import { BrowserPreview, BrowserPreviewInputSchema, BrowserPreviewResultSchema } from "../preview"
import type { BrowserPreviewOptions } from "../preview-network"

const PreviewQuery = z
  .object({
    mode: z.literal("scope").default("scope"),
    directory: z.string().max(20_000).optional(),
    scopeID: z.string().max(1_000).optional(),
  })
  .strict()
const PreviewError = z.object({ code: z.string(), message: z.string() }).strict()

export const BrowserPreviewRoutes = (options: BrowserPreviewOptions = {}) =>
  new Hono().post(
    "/:directory/browser/preview",
    describeRoute({
      summary: "Preview an anonymous public webpage",
      description:
        "Read public metadata or a fixed-commit GitHub source excerpt without using a website identity or creating a Browser page.",
      operationId: "browser.preview",
      responses: {
        200: {
          description: "Public metadata or a typed unavailable reason",
          content: { "application/json": { schema: resolver(BrowserPreviewResultSchema) } },
        },
        400: {
          description: "Invalid preview request",
          content: { "application/json": { schema: resolver(PreviewError) } },
        },
        413: {
          description: "Preview request is too large",
          content: { "application/json": { schema: resolver(PreviewError) } },
        },
      },
    }),
    async (context, next) => {
      if (
        Number(context.req.header("content-length")) > 32 * 1024 ||
        !(await requestWithinLimit(context.req.raw, 32 * 1024))
      ) {
        return context.json(
          { code: "browser_preview_payload_too_large", message: "Preview request is too large." },
          413,
        )
      }
      await next()
    },
    validator("query", PreviewQuery),
    validator("json", BrowserPreviewInputSchema),
    async (context) => {
      const scope = ScopeContext.current.scope
      if (context.req.valid("query").scopeID && context.req.valid("query").scopeID !== scope.id) {
        return context.json(
          { code: "browser_preview_scope_mismatch", message: "Preview Scope does not match the request context." },
          400,
        )
      }
      context.header("Cache-Control", "no-store")
      return context.json(
        await BrowserPreview.read(context.req.valid("json"), { ...options, signal: context.req.raw.signal }),
      )
    },
  )
