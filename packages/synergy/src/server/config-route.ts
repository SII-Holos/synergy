import { type Context, Hono, type Next } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { mapValues } from "remeda"
import z from "zod"
import { Config } from "../config/config"
import { ConfigDomain } from "../config/domain"
import { ConfigImport } from "../config/import"
import { ConfigDomainOpen } from "../config/domain-open"
import { Provider } from "../provider/provider"
import { RuntimeReload } from "../runtime/reload"
import { Log } from "../util/log"
import { BadRequestError, errors } from "./error"
import { requestWithinLimit } from "./request-body-limit"

const log = Log.create({ service: "config-route" })

function classifyChangedFields(rawBody: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(rawBody))
}

const DomainUpdateInput = z
  .object({
    config: Config.Info,
    mode: ConfigDomain.MergeMode.optional(),
  })
  .meta({ ref: "ConfigDomainUpdateInput" })

const DomainOpenResponse = z
  .object({
    success: z.literal(true),
    path: z.string(),
  })
  .meta({ ref: "ConfigDomainOpenResponse" })

const DomainOpenError = z
  .object({
    success: z.literal(false),
    error: z.string(),
    message: z.string(),
    path: z.string().optional(),
  })
  .meta({ ref: "ConfigDomainOpenError" })
const ConfigImportInvalidConfigError = z
  .object({
    name: z.literal("ConfigInvalidError"),
    data: z.object({
      path: z.string(),
      issues: z.array(z.any()).optional(),
      message: z.string().optional(),
    }),
  })
  .meta({ ref: "ConfigImportInvalidConfigError" })

const ConfigImportBadRequestError = z.union([
  BadRequestError,
  ConfigImport.ProjectScopeRequiredError.Schema,
  ConfigImportInvalidConfigError,
])

const ConfigImportConflictError = z.union([ConfigImport.RevisionConflictError.Schema, ConfigImport.LockedError.Schema])

function limitConfigImportBody(maxBytes: number) {
  return async (c: Context, next: Next) => {
    const declared = Number(c.req.header("content-length") ?? 0)
    if ((Number.isFinite(declared) && declared > maxBytes) || !(await requestWithinLimit(c.req.raw, maxBytes))) {
      const error = new ConfigImport.SourceTooLargeError({
        source: c.req.path,
        maxBytes,
        message: `CONFIG_TOO_LARGE: Config import request exceeds ${maxBytes} bytes`,
      })
      return c.json(error.toObject(), 413)
    }
    await next()
  }
}

export function domainOpenError(error: unknown) {
  if (error instanceof ConfigDomainOpen.UnsupportedPlatformError) {
    return {
      status: 400 as const,
      body: { success: false as const, error: error.name, message: error.message, path: error.filepath },
    }
  }
  if (error instanceof ConfigDomainOpen.OpenerMissingError) {
    return {
      status: 500 as const,
      body: { success: false as const, error: error.name, message: error.message, path: error.filepath },
    }
  }
  if (error instanceof ConfigDomainOpen.OpenFailedError) {
    return {
      status: 500 as const,
      body: { success: false as const, error: error.name, message: error.message, path: error.filepath },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500 as const, body: { success: false as const, error: "ConfigDomainOpenError", message } }
}

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
          content: { "application/json": { schema: resolver(Config.Info) } },
        },
      },
    }),
    async (c) => c.json(Config.redactForClient(await Config.current())),
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
          content: { "application/json": { schema: resolver(Config.Info) } },
        },
        ...errors(400),
      },
    }),
    validator("json", z.object({ config: Config.Info })),
    async (c) => {
      const rawBody = c.req.valid("json").config as Record<string, unknown>
      const changedFields = classifyChangedFields(rawBody)
      const storedConfig = await Config.current()
      const validated = Config.Info.parse(rawBody)
      const merged = Config.mergeRedactedSecrets(validated, storedConfig)
      await Config.updateGlobal(merged)
      await reloadAfterConfigChange(changedFields, "config.update route")
      return c.json(Config.redactForClient(await Config.current()))
    },
  )
  .get(
    "/global",
    describeRoute({
      summary: "Get global configuration",
      description: "Retrieve only the canonical global domain configuration.",
      operationId: "config.global",
      responses: {
        200: {
          description: "Get global config info",
          content: { "application/json": { schema: resolver(Config.Info) } },
        },
      },
    }),
    async (c) => c.json(Config.redactForClient(await Config.globalRaw())),
  )
  .get(
    "/domains",
    describeRoute({
      summary: "List config domains",
      description: "List canonical config domains and their current global fragments.",
      operationId: "config.domain.list",
      responses: {
        200: {
          description: "List of config domains",
          content: { "application/json": { schema: resolver(Config.DomainSummary.array()) } },
        },
      },
    }),
    async (c) => c.json(await Config.domainList()),
  )
  .get(
    "/domains/:domain",
    describeRoute({
      summary: "Get config domain",
      description: "Read one canonical global config domain fragment.",
      operationId: "config.domain.get",
      responses: {
        200: {
          description: "Config domain fragment",
          content: { "application/json": { schema: resolver(Config.Info) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ domain: ConfigDomain.Id })),
    async (c) => {
      const { domain } = c.req.valid("param")
      return c.json(Config.redactForClient(await Config.domainGet(domain)))
    },
  )
  .patch(
    "/domains/:domain",
    describeRoute({
      summary: "Update config domain",
      description: "Update one canonical global config domain fragment.",
      operationId: "config.domain.update",
      responses: {
        200: {
          description: "Updated config domain fragment",
          content: { "application/json": { schema: resolver(Config.Info) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ domain: ConfigDomain.Id })),
    validator("json", DomainUpdateInput),
    async (c) => {
      const { domain } = c.req.valid("param")
      const body = c.req.valid("json")
      const changedFields = classifyChangedFields(body.config as Record<string, unknown>)
      const result = await Config.domainUpdate(domain, body.config, { mode: body.mode })
      await reloadAfterConfigChange(changedFields, `config.domain.update:${domain}`)
      return c.json(result)
    },
  )
  .post(
    "/domains/:domain/open",
    describeRoute({
      summary: "Open config domain file",
      description: "Materialize and open one canonical global config domain file with the operating system default.",
      operationId: "config.domain.open",
      responses: {
        200: {
          description: "Opened config domain file",
          content: { "application/json": { schema: resolver(DomainOpenResponse) } },
        },
        400: {
          description: "Unsupported platform",
          content: { "application/json": { schema: resolver(DomainOpenError) } },
        },
        500: {
          description: "Failed to open config domain file",
          content: { "application/json": { schema: resolver(DomainOpenError) } },
        },
      },
    }),
    validator("param", z.object({ domain: ConfigDomain.Id })),
    async (c) => {
      const { domain } = c.req.valid("param")
      try {
        return c.json(await ConfigDomainOpen.open(domain))
      } catch (error) {
        const result = domainOpenError(error)
        return c.json(result.body, result.status)
      }
    },
  )
  .post(
    "/import/plan",
    describeRoute({
      summary: "Plan config import",
      description: "Create a dry-run plan for importing selected config domains into global or project config.",
      operationId: "config.import.plan",
      responses: {
        200: {
          description: "Config import plan",
          content: { "application/json": { schema: resolver(ConfigImport.Plan) } },
        },
        400: {
          description: "Invalid import or missing project scope",
          content: { "application/json": { schema: resolver(ConfigImportBadRequestError) } },
        },
        413: {
          description: "Config import request is too large",
          content: { "application/json": { schema: resolver(ConfigImport.SourceTooLargeError.Schema) } },
        },
      },
    }),
    limitConfigImportBody(ConfigImport.MAX_REQUEST_BYTES),
    validator("json", ConfigImport.PlanInput),
    async (c) => c.json(await ConfigImport.plan(c.req.valid("json"))),
  )
  .post(
    "/import/apply",
    describeRoute({
      summary: "Apply config import",
      description: "Atomically apply a selected-domain config import plan and reload affected runtime state.",
      operationId: "config.import.apply",
      responses: {
        200: {
          description: "Applied config import result",
          content: { "application/json": { schema: resolver(ConfigImport.ApplyResult) } },
        },
        400: {
          description: "Invalid import or missing project scope",
          content: { "application/json": { schema: resolver(ConfigImportBadRequestError) } },
        },
        409: {
          description: "Stale plan or concurrent import",
          content: { "application/json": { schema: resolver(ConfigImportConflictError) } },
        },
        413: {
          description: "Config import request is too large",
          content: { "application/json": { schema: resolver(ConfigImport.SourceTooLargeError.Schema) } },
        },
      },
    }),
    limitConfigImportBody(ConfigImport.MAX_REQUEST_BYTES),
    validator("json", ConfigImport.ApplyInput),
    async (c) => c.json(await ConfigImport.apply(c.req.valid("json"))),
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

async function reloadAfterConfigChange(changedFields: Set<string>, reason: string) {
  const hasCascade = RuntimeReload.inferConfigCascades([...changedFields]).length > 0
  const allClientSide =
    changedFields.size > 0 && [...changedFields].every((f) => RuntimeReload.CONFIG_CLIENT_SIDE.has(f))
  const allLiveNoCascade =
    changedFields.size > 0 && [...changedFields].every((f) => RuntimeReload.CONFIG_LIVE_APPLIED.has(f)) && !hasCascade

  if (allClientSide) {
    log.info("config updated (client-side only, skipping reload)", { changedFields: [...changedFields] })
    return
  }
  if (allLiveNoCascade) {
    await Config.reload("global")
    log.info("config updated (live-applied, no cascade)", { changedFields: [...changedFields] })
    return
  }
  const result = await RuntimeReload.reload({
    targets: ["config"],
    scope: "global",
    reason,
  })
  log.info("config updated", {
    changedFields: result.changedFields,
    restartRequired: result.restartRequired,
    warnings: result.warnings,
  })
}
