import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { mapValues } from "remeda"
import z from "zod"
import { Config } from "../config/config"
import { ConfigSet } from "../config/set"
import { Provider } from "../provider/provider"
import { RuntimeReload } from "../runtime/reload"
import { RuntimeSchema } from "../runtime/schema"
import { Log } from "../util/log"
import { errors } from "./error"

const log = Log.create({ service: "config-route" })

const ConfigSetWithConfig = ConfigSet.Summary.extend({
  config: Config.Info,
}).meta({ ref: "ConfigSetWithConfig" })

const ConfigSetCreateInput = z
  .object({
    name: ConfigSet.Name,
    config: Config.Info.optional(),
  })
  .meta({ ref: "ConfigSetCreateInput" })

const ConfigSetActivateResult = z
  .object({
    previous: ConfigSet.Name,
    active: ConfigSet.Name,
    changed: z.boolean(),
    runtimeReload: RuntimeSchema.ReloadResult,
  })
  .meta({ ref: "ConfigSetActivateResult" })

const ConfigSetRawValidateInput = z
  .object({
    raw: z.string(),
  })
  .meta({ ref: "ConfigSetRawValidateInput" })

const ConfigSetRawSaveInput = z
  .object({
    raw: z.string(),
    reload: z.boolean().optional(),
  })
  .meta({ ref: "ConfigSetRawSaveInput" })

export const ConfigRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "Get configuration",
      description: "Retrieve the current Synergy configuration settings and preferences.",
      operationId: "config.get",
      responses: {
        200: {
          description: "Get config info",
          content: {
            "application/json": {
              schema: resolver(Config.Info),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await Config.get())
    },
  )
  .patch(
    "/",
    describeRoute({
      summary: "Update configuration",
      description: "Update Synergy configuration settings and preferences.",
      operationId: "config.update",
      responses: {
        200: {
          description: "Successfully updated config",
          content: {
            "application/json": {
              schema: resolver(Config.Info),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", Config.Info),
    async (c) => {
      const config = c.req.valid("json")
      await Config.updateGlobal(config)
      const result = await RuntimeReload.reload({
        targets: ["config"],
        scope: "global",
        reason: "config.update route",
      })
      log.info("config updated", {
        changedFields: result.changedFields,
        restartRequired: result.restartRequired,
        warnings: result.warnings,
      })
      return c.json(await Config.get())
    },
  )
  .get(
    "/global",
    describeRoute({
      summary: "Get global configuration",
      description: "Retrieve only the active global Config Set raw configuration (without project or remote layers).",
      operationId: "config.global",
      responses: {
        200: {
          description: "Get global config info",
          content: {
            "application/json": {
              schema: resolver(Config.Info),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await Config.globalRaw())
    },
  )
  .get(
    "/sets",
    describeRoute({
      summary: "List Config Sets",
      description: "List all global Config Sets and indicate which one is active.",
      operationId: "config.set.list",
      responses: {
        200: {
          description: "List of Config Sets",
          content: {
            "application/json": {
              schema: resolver(ConfigSet.Summary.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await Config.configSetList())
    },
  )
  .post(
    "/sets",
    describeRoute({
      summary: "Create Config Set",
      description: "Create a new global Config Set, defaulting to a copy of the current active raw global config.",
      operationId: "config.set.create",
      responses: {
        200: {
          description: "Created Config Set",
          content: {
            "application/json": {
              schema: resolver(ConfigSetWithConfig),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", ConfigSetCreateInput),
    async (c) => {
      const body = c.req.valid("json")
      return c.json(await Config.configSetCreate(body.name, body.config))
    },
  )
  .get(
    "/sets/:name",
    describeRoute({
      summary: "Get Config Set",
      description: "Read a global Config Set and its raw configuration.",
      operationId: "config.set.get",
      responses: {
        200: {
          description: "Config Set",
          content: {
            "application/json": {
              schema: resolver(ConfigSetWithConfig),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ name: ConfigSet.Name })),
    async (c) => {
      const { name } = c.req.valid("param")
      return c.json(await Config.configSetGet(name))
    },
  )
  .patch(
    "/sets/:name",
    describeRoute({
      summary: "Update Config Set",
      description: "Patch a global Config Set raw configuration.",
      operationId: "config.set.update",
      responses: {
        200: {
          description: "Updated Config Set",
          content: {
            "application/json": {
              schema: resolver(ConfigSetWithConfig),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ name: ConfigSet.Name })),
    validator("json", Config.Info),
    async (c) => {
      const { name } = c.req.valid("param")
      const body = c.req.valid("json")
      return c.json(await Config.configSetUpdate(name, body))
    },
  )
  .get(
    "/sets/:name/raw",
    describeRoute({
      summary: "Get Config Set raw",
      description: "Read a global Config Set raw JSONC source and parsed preview.",
      operationId: "config.set.raw.get",
      responses: {
        200: {
          description: "Config Set raw source",
          content: {
            "application/json": {
              schema: resolver(Config.RawSet),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ name: ConfigSet.Name })),
    async (c) => {
      const { name } = c.req.valid("param")
      return c.json(await Config.configSetGetRaw(name))
    },
  )
  .post(
    "/sets/:name/raw/validate",
    describeRoute({
      summary: "Validate Config Set raw",
      description: "Validate raw JSONC for a global Config Set without saving it.",
      operationId: "config.set.raw.validate",
      responses: {
        200: {
          description: "Validation result",
          content: {
            "application/json": {
              schema: resolver(Config.RawValidationResult),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ name: ConfigSet.Name })),
    validator("json", ConfigSetRawValidateInput),
    async (c) => {
      const { name } = c.req.valid("param")
      const body = c.req.valid("json")
      await ConfigSet.assertExists(name)
      return c.json(await Config.validateRaw(body.raw, ConfigSet.filePath(name)))
    },
  )
  .put(
    "/sets/:name/raw",
    describeRoute({
      summary: "Save Config Set raw",
      description: "Save raw JSONC for a global Config Set after validation and optionally reload runtime if active.",
      operationId: "config.set.raw.save",
      responses: {
        200: {
          description: "Saved Config Set raw source",
          content: {
            "application/json": {
              schema: resolver(Config.RawSaveResult),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ name: ConfigSet.Name })),
    validator("json", ConfigSetRawSaveInput),
    async (c) => {
      const { name } = c.req.valid("param")
      const body = c.req.valid("json")
      const result = await Config.configSetSaveRaw(name, body.raw, body.reload ?? true)
      if (result.runtimeReload) {
        log.info("config set raw saved", {
          name,
          changedFields: result.runtimeReload.changedFields,
          restartRequired: result.runtimeReload.restartRequired,
          warnings: result.runtimeReload.warnings,
        })
      }
      return c.json(result)
    },
  )
  .delete(
    "/sets/:name",
    describeRoute({
      summary: "Delete Config Set",
      description: "Delete an inactive non-default global Config Set.",
      operationId: "config.set.delete",
      responses: {
        200: {
          description: "Deleted Config Set",
          content: {
            "application/json": {
              schema: resolver(ConfigSet.Summary),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ name: ConfigSet.Name })),
    async (c) => {
      const { name } = c.req.valid("param")
      return c.json(await Config.configSetDelete(name))
    },
  )
  .post(
    "/sets/:name/activate",
    describeRoute({
      summary: "Activate Config Set",
      description: "Activate a global Config Set and reload global runtime configuration.",
      operationId: "config.set.activate",
      responses: {
        200: {
          description: "Activated Config Set",
          content: {
            "application/json": {
              schema: resolver(ConfigSetActivateResult),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ name: ConfigSet.Name })),
    async (c) => {
      const { name } = c.req.valid("param")
      const activation = await Config.configSetActivate(name)
      const runtimeReload = await RuntimeReload.reload({
        targets: ["all"],
        scope: "global",
        reason: `config.set.activate:${activation.active}`,
      })
      log.info("config set activated", {
        previous: activation.previous,
        active: activation.active,
        changed: activation.changed,
        changedFields: runtimeReload.changedFields,
        restartRequired: runtimeReload.restartRequired,
        warnings: runtimeReload.warnings,
      })
      return c.json({
        ...activation,
        runtimeReload,
      })
    },
  )
  .get(
    "/providers",
    describeRoute({
      summary: "List config providers",
      description: "Get a list of all configured AI providers and their default models.",
      operationId: "config.providers",
      responses: {
        200: {
          description: "List of providers",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  providers: Provider.Info.array(),
                  default: z.record(z.string(), z.string()),
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      using _ = log.time("providers")
      const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
      return c.json({
        providers: Object.values(providers),
        default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
      })
    },
  )
