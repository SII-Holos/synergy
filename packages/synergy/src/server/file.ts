import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { File } from "../file"
import z from "zod"

export const FileRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List files",
      description: "List files and directories in a specified path.",
      operationId: "file.list",
      responses: {
        200: {
          description: "Files and directories",
          content: {
            "application/json": {
              schema: resolver(File.Node.array()),
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
      const path = c.req.valid("query").path
      const content = await File.list(path)
      return c.json(content)
    },
  )
  .get(
    "/content",
    describeRoute({
      summary: "Read file",
      description: "Read the content of a specified file.",
      operationId: "file.read",
      responses: {
        200: {
          description: "File content",
          content: {
            "application/json": {
              schema: resolver(File.Content),
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
      const path = c.req.valid("query").path
      const content = await File.read(path)
      return c.json(content)
    },
  )
  .get(
    "/status",
    describeRoute({
      summary: "Get file status",
      description: "Get the git status of all files in the project.",
      operationId: "file.status",
      responses: {
        200: {
          description: "File status",
          content: {
            "application/json": {
              schema: resolver(File.Info.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const content = await File.status()
      return c.json(content)
    },
  )
