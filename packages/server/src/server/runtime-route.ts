import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import {
  AgentWorkerCapacityStatus,
  agentWorkerCapacityStatus,
} from "@ericsanchezok/synergy-harness/execution/execution-config"
import { RuntimeReloadExecutor } from "@ericsanchezok/synergy-harness/config/reload-executor"
import { RuntimeSchema } from "@ericsanchezok/synergy-harness/config/reload-schema"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { errors } from "./error"

export const RuntimeRoute = new Hono()
  .post(
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
  .get(
    "/agent-workers",
    describeRoute({
      summary: "Get Agent worker capacity status",
      description:
        "Get the explicit Agent worker ceiling, the capacity the runtime resolves from it, and whether configuration or the machine decided it.",
      operationId: "runtime.agentWorkers",
      responses: {
        200: {
          description: "Agent worker capacity status",
          content: {
            "application/json": {
              schema: resolver(AgentWorkerCapacityStatus),
            },
          },
        },
      },
    }),
    async (c) => {
      const config = await Config.current()
      return c.json(agentWorkerCapacityStatus(config, ScopeStartup.resident() ? "server" : "oneshot"))
    },
  )
