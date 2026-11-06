import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { ProjectTaskDefaults } from "../task-defaults"

export function ProjectTaskDefaultsRoute() {
  const success = {
    description: "Project task defaults",
    content: { "application/json": { schema: resolver(ProjectTaskDefaults.Result) } },
  }
  return new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get project new-task defaults",
        operationId: "project.taskDefaults.get",
        responses: { 200: success },
      }),
      async (c) => c.json(await ProjectTaskDefaults.get()),
    )
    .patch(
      "/",
      describeRoute({
        summary: "Save project new-task defaults",
        description:
          "Updates only Web and Desktop new-task defaults. Existing sessions and runtime creation rules are unchanged.",
        operationId: "project.taskDefaults.update",
        responses: {
          200: success,
          400: {
            description: "Invalid defaults",
            content: { "application/json": { schema: resolver(ProjectTaskDefaults.Invalid.Schema) } },
          },
          409: {
            description: "Concurrent project edit",
            content: { "application/json": { schema: resolver(ProjectTaskDefaults.Conflict.Schema) } },
          },
        },
      }),
      validator("json", ProjectTaskDefaults.Input),
      async (c) => {
        try {
          return c.json(await ProjectTaskDefaults.update(c.req.valid("json")))
        } catch (error) {
          if (error instanceof ProjectTaskDefaults.Conflict) return c.json(error.toObject(), 409)
          if (error instanceof ProjectTaskDefaults.Invalid) return c.json(error.toObject(), 400)
          throw error
        }
      },
    )
}
