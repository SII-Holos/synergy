import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { errors } from "@ericsanchezok/synergy-server/server/error"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { Render } from "."

const route = "/:sessionID/:messageID/:partID"
export function RenderRoute() {
  return new Hono()
    .get(
      route,
      describeRoute({
        summary: "Read an owned visual",
        operationId: "render.get",
        responses: {
          200: {
            description: "Immutable source and current state",
            content: { "application/json": { schema: resolver(RenderArtifact.Snapshot) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", RenderArtifact.Target),
      async (c) => {
        try {
          return c.json(await Render.read(c.req.valid("param")))
        } catch (error) {
          if (error instanceof Render.Unavailable) return c.json(error.toObject(), 404)
          throw error
        }
      },
    )
    .put(
      route,
      describeRoute({
        summary: "Save visual state without invoking a model",
        operationId: "render.update",
        responses: {
          200: {
            description: "Committed state",
            content: { "application/json": { schema: resolver(RenderArtifact.State) } },
          },
          409: {
            description: "Revision conflict",
            content: { "application/json": { schema: resolver(Render.Conflict.Schema) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", RenderArtifact.Target),
      validator("json", RenderArtifact.Write),
      async (c) => {
        try {
          return c.json(await Render.write(c.req.valid("param"), c.req.valid("json")))
        } catch (error) {
          if (error instanceof Render.Conflict) return c.json(error.toObject(), 409)
          if (error instanceof Render.Unavailable) return c.json(error.toObject(), 404)
          throw error
        }
      },
    )
}
