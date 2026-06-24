import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { mapValues } from "remeda"
import z from "zod"
import { Config } from "../config/config"
import { ConfigDomain } from "../config/domain"
import { Provider } from "../provider/provider"
import { RuntimeReload } from "../runtime/reload"
import { Log } from "../util/log"
import { errors } from "./error"

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
    async (c) => c.json(Config.redactForClient(await Config.get())),
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
      const storedConfig = await Config.get()
      const validated = Config.Info.parse(rawBody)
      const merged = Config.mergeRedactedSecrets(validated, storedConfig)
      await Config.updateGlobal(merged)
      await reloadAfterConfigChange(changedFields, "config.update route")
      return c.json(Config.redactForClient(await Config.get()))
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
    "/import/plan",
    describeRoute({
      summary: "Plan config import",
      description: "Create a dry-run plan for importing selected config domains.",
      operationId: "config.import.plan",
      responses: {
        200: {
          description: "Config import plan",
          content: { "application/json": { schema: resolver(Config.DomainImportPlan) } },
        },
        ...errors(400),
      },
    }),
    validator("json", Config.DomainImportPlanInput),
    async (c) => c.json(await Config.domainImportPlan(c.req.valid("json"))),
  )
  .post(
    "/import/apply",
    describeRoute({
      summary: "Apply config import",
      description: "Apply a selected-domain config import plan.",
      operationId: "config.import.apply",
      responses: {
        200: {
          description: "Applied config import plan",
          content: { "application/json": { schema: resolver(Config.DomainImportPlan) } },
        },
        ...errors(400),
      },
    }),
    validator("json", Config.DomainImportPlanInput.extend({ yes: z.boolean().optional() })),
    async (c) => {
      const plan = await Config.domainImportApply(c.req.valid("json"))
      const changedFields = new Set(plan.domains.flatMap((domain) => domain.changes.map((change) => change.key)))
      await reloadAfterConfigChange(changedFields, "config.import.apply")
      return c.json(plan)
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
