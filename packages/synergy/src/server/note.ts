import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { NoteError, NoteMarkdown, NoteStore, NoteTypes } from "../note"
import { Instance } from "../scope/instance"
import { Storage } from "../storage/storage"

export const NoteRoute = new Hono()

  .get(
    "/all",
    describeRoute({
      summary: "List all notes grouped by scope",
      description: "List all notes across all scopes, grouped by scope ID.",
      operationId: "note.listAll",
      responses: {
        200: {
          description: "Notes grouped by scope",
          content: { "application/json": { schema: resolver(NoteTypes.ScopeGroup.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const groups = await NoteStore.listGrouped()
        return c.json(groups)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .get(
    "/export/:id",
    describeRoute({
      summary: "Export note",
      description: "Export a note as Markdown or HTML.",
      operationId: "note.export",
      responses: {
        200: { description: "Exported note content" },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Note ID" }) })),
    validator(
      "query",
      z.object({ format: z.enum(["md", "html"]).default("md").meta({ description: "Export format" }) }),
    ),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const format = c.req.valid("query").format
        const note = await NoteStore.getAny(Instance.scope.id, id)
        const markdown = NoteMarkdown.toMarkdown(note.content)
        const safeTitle = note.title.replace(/[^\w\s-]/g, "").trim() || "note"

        if (format === "html") {
          const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${note.title}</title></head><body>
<pre>${markdown}</pre>
</body></html>`
          return c.html(html, 200, {
            "Content-Disposition": `attachment; filename="${safeTitle}.html"`,
          })
        }

        return c.body(markdown, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeTitle}.md"`,
        })
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Note not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .post(
    "/",
    describeRoute({
      summary: "Create note",
      description: "Create a new note in the current scope.",
      operationId: "note.create",
      responses: {
        200: {
          description: "Created note",
          content: { "application/json": { schema: resolver(NoteTypes.Info) } },
        },
        ...errors(400),
      },
    }),
    validator("json", NoteTypes.CreateInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const note = await NoteStore.create(body)
        return c.json(note)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .get(
    "/:id",
    describeRoute({
      summary: "Get note",
      description: "Get a specific note by ID.",
      operationId: "note.get",
      responses: {
        200: {
          description: "Note",
          content: { "application/json": { schema: resolver(NoteTypes.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Note ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const note = await NoteStore.getAny(Instance.scope.id, id)
        return c.json(note)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Note not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .put(
    "/:id",
    describeRoute({
      summary: "Update note",
      description: "Update a note's content or metadata.",
      operationId: "note.update",
      responses: {
        200: {
          description: "Updated note",
          content: { "application/json": { schema: resolver(NoteTypes.Info) } },
        },
        ...errors(400, 404, 409),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Note ID" }) })),
    validator("json", NoteTypes.PatchInput),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const body = c.req.valid("json")
        const note = await NoteStore.updateAny(Instance.scope.id, id, body)
        return c.json(note)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Note not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof NoteError.Conflict) return c.json(err.toObject(), 409)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .delete(
    "/:id",
    describeRoute({
      summary: "Delete note",
      description: "Delete a note permanently.",
      operationId: "note.remove",
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Note ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        await NoteStore.removeAny(Instance.scope.id, id)
        return c.json(true)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .get(
    "/",
    describeRoute({
      summary: "List notes",
      description: "List all notes for the current scope, including global notes.",
      operationId: "note.list",
      responses: {
        200: {
          description: "List of notes",
          content: { "application/json": { schema: resolver(NoteTypes.Info.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const notes = await NoteStore.listWithGlobal(Instance.scope.id)
        return c.json(notes)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
