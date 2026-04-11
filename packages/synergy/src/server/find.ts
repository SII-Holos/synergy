import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { Ripgrep } from "../file/ripgrep"
import { File } from "../file"
import { LSP } from "../lsp"
import { Instance } from "../scope/instance"

export const FindRoute = new Hono()
  .get(
    "/browse",
    describeRoute({
      summary: "Browse directories",
      description: "Browse filesystem directories by path with optional fuzzy search. Returns absolute paths.",
      operationId: "find.browse",
      responses: {
        200: {
          description: "Directory paths",
          content: {
            "application/json": {
              schema: resolver(z.string().array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        path: z.string(),
        query: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        depth: z.coerce.number().int().min(1).max(10).optional(),
      }),
    ),
    async (c) => {
      const { path, query, limit, depth } = c.req.valid("query")
      const results = await File.browse({ path, query, limit: limit ?? 50, depth: depth ?? 4 })
      return c.json(results)
    },
  )
  .get(
    "/",
    describeRoute({
      summary: "Find text",
      description: "Search for text patterns across files in the project using ripgrep.",
      operationId: "find.text",
      responses: {
        200: {
          description: "Matches",
          content: {
            "application/json": {
              schema: resolver(Ripgrep.Match.shape.data.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        pattern: z.string(),
      }),
    ),
    async (c) => {
      const pattern = c.req.valid("query").pattern
      const result = await Ripgrep.search({
        cwd: Instance.directory,
        pattern,
        limit: 10,
      })
      return c.json(result)
    },
  )
  .get(
    "/file",
    describeRoute({
      summary: "Find files",
      description: "Search for files or directories by name or pattern in the project directory.",
      operationId: "find.files",
      responses: {
        200: {
          description: "File paths",
          content: {
            "application/json": {
              schema: resolver(z.string().array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        query: z.string(),
        dirs: z.enum(["true", "false"]).optional(),
        type: z.enum(["file", "directory"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query").query
      const dirs = c.req.valid("query").dirs
      const type = c.req.valid("query").type
      const limit = c.req.valid("query").limit
      const results = await File.search({
        query,
        limit: limit ?? 10,
        dirs: dirs !== "false",
        type,
      })
      return c.json(results)
    },
  )
  .get(
    "/symbol",
    describeRoute({
      summary: "Find symbols",
      description: "Search for workspace symbols like functions, classes, and variables using LSP.",
      operationId: "find.symbols",
      responses: {
        200: {
          description: "Symbols",
          content: {
            "application/json": {
              schema: resolver(LSP.Symbol.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        query: z.string(),
      }),
    ),
    async (c) => {
      /*
          const query = c.req.valid("query").query
          const result = await LSP.workspaceSymbol(query)
          return c.json(result)
          */
      return c.json([])
    },
  )
