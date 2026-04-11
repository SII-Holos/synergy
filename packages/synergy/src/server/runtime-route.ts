import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import { RuntimeReload } from "../runtime/reload"
import { errors } from "./error"

export const RuntimeRoute = new Hono().post(
  "/reload",
  describeRoute({
    summary: "Reload runtime state",
    description: "Reload Synergy runtime subsystems after self-configuration changes.",
    operationId: "runtime.reload",
    responses: {
      200: {
        description: "Runtime reload completed",
        content: {
          "application/json": {
            schema: resolver(RuntimeReload.Result),
          },
        },
      },
      ...errors(400),
    },
  }),
  validator("json", RuntimeReload.Input),
  async (c) => {
    const body = c.req.valid("json")
    return c.json(await RuntimeReload.reload(body))
  },
)
