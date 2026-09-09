import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import { RuntimeReloadExecutor } from "@ericsanchezok/synergy-harness/config/reload-executor"
import { RuntimeSchema } from "@ericsanchezok/synergy-harness/config/reload-schema"
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
            schema: resolver(RuntimeSchema.ReloadResult),
          },
        },
      },
      ...errors(400),
    },
  }),
  validator("json", RuntimeSchema.ReloadInput),
  async (c) => {
    const body = c.req.valid("json")
    return c.json(await RuntimeReloadExecutor.reload(body))
  },
)
