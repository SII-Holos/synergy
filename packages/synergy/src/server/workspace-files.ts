import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { WorkspaceFile } from "../workspace-file/types"
import { WorkspaceFileSearch } from "../workspace-file/search"
import { WorkspaceFileService } from "../workspace-file/service"
import { WorkspaceFileStatus } from "../workspace-file/status"

const BoolString = z.enum(["true", "false"]).optional()

function bool(value: "true" | "false" | undefined) {
  return value === "true"
}

function parseRange(input: string | undefined) {
  if (!input) return {}
  const match = input.trim().match(/^(\d+)\s*(?::|,|-)\s*(\d+)$/)
  if (!match) return {}
  const start = Number.parseInt(match[1]!, 10)
  const endOrLimit = Number.parseInt(match[2]!, 10)
  if (!Number.isFinite(start) || !Number.isFinite(endOrLimit)) return {}
  if (input.includes("-")) {
    return {
      offset: Math.max(0, start),
      limit: Math.max(1, endOrLimit - start + 1),
    }
  }
  return {
    offset: Math.max(0, start),
    limit: Math.max(1, endOrLimit),
  }
}

export const WorkspaceFilesRoute = new Hono()
  .get(
    "/children",
    describeRoute({
      summary: "List workspace file children",
      description: "List direct children for a workspace directory with lazy-loading friendly pagination.",
      operationId: "workspace.files.children",
      responses: {
        200: {
          description: "Workspace file children",
          content: {
            "application/json": {
              schema: resolver(WorkspaceFile.ChildrenResponse),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        path: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        cursor: z.string().optional(),
        showHidden: BoolString,
        showIgnored: BoolString,
      }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      return c.json(
        await WorkspaceFileService.children({
          path: query.path,
          limit: query.limit,
          cursor: query.cursor,
          showHidden: bool(query.showHidden),
          showIgnored: bool(query.showIgnored),
        }),
      )
    },
  )
  .get(
    "/read",
    describeRoute({
      summary: "Read workspace file",
      description: "Read a workspace file as text, image preview, or binary metadata.",
      operationId: "workspace.files.read",
      responses: {
        200: {
          description: "Workspace file read result",
          content: {
            "application/json": {
              schema: resolver(WorkspaceFile.ReadResult),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        path: z.string(),
        range: z.string().optional(),
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(5000).optional(),
        preview: BoolString,
        mode: z.enum(["range", "document"]).default("range"),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      const range = parseRange(query.range)
      return c.json(
        await WorkspaceFileService.read({
          path: query.path,
          offset: query.offset ?? range.offset,
          limit: query.limit ?? range.limit,
          preview: bool(query.preview),
          mode: query.mode,
        }),
      )
    },
  )
  .get(
    "/stat",
    describeRoute({
      summary: "Stat workspace file",
      description: "Return metadata for a workspace file or directory.",
      operationId: "workspace.files.stat",
      responses: {
        200: {
          description: "Workspace file node",
          content: {
            "application/json": {
              schema: resolver(WorkspaceFile.Node),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        path: z.string(),
      }),
    ),
    async (c) => {
      return c.json(await WorkspaceFileService.node(c.req.valid("query").path))
    },
  )
  .get(
    "/search",
    describeRoute({
      summary: "Search workspace files",
      description: "Search workspace files, content, or active LSP symbols.",
      operationId: "workspace.files.search",
      responses: {
        200: {
          description: "Workspace search response",
          content: {
            "application/json": {
              schema: resolver(WorkspaceFile.SearchResponse),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        query: z.string(),
        kind: z.enum(["files", "content", "symbol"]).default("files"),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
        include: z.string().optional(),
        exclude: z.string().optional(),
      }),
    ),
    async (c) => {
      return c.json(await WorkspaceFileSearch.search({ ...c.req.valid("query"), signal: c.req.raw.signal }))
    },
  )
  .get(
    "/status",
    describeRoute({
      summary: "Get workspace file status",
      description: "Return git-backed file status for the current workspace.",
      operationId: "workspace.files.status",
      responses: {
        200: {
          description: "Workspace file status",
          content: {
            "application/json": {
              schema: resolver(WorkspaceFile.StatusSummary),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await WorkspaceFileStatus.summary())
    },
  )
