import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { Config } from "@/config/config"
import type { ModelsDev } from "./models"
import { ProviderCatalog } from "./catalog"
import { ProviderProfile } from "./profile"
import { Auth } from "./api-key"
import { Lock } from "@/util/lock"

export namespace ProviderConnection {
  const MUTATION_LOCK = "provider-connection:global-config"
  const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      profileID: z.string(),
      catalogProviderID: z.string(),
      endpoint: z.string().optional(),
      enabled: z.boolean(),
      configured: z.boolean(),
      removable: z.boolean(),
    })
    .strict()
    .meta({ ref: "ProviderConnection" })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z
    .object({
      profileID: z.string().min(1),
      name: z.string().trim().min(1).max(80),
      id: z.string().regex(ID_PATTERN).optional(),
      endpoint: z.string().url().optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ProviderConnectionCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      endpoint: z.string().url().nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .refine((input) => Object.keys(input).length > 0, { message: "At least one account field must be provided" })
    .meta({ ref: "ProviderConnectionUpdateInput" })
  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Removed = z
    .object({
      providerID: z.string(),
      removed: z.literal(true),
    })
    .strict()
    .meta({ ref: "ProviderConnectionRemoveResponse" })

  export const ProfileNotFound = NamedError.create(
    "ProviderConnectionProfileNotFoundError",
    z.object({ profileID: z.string() }),
  )
  export const CatalogNotFound = NamedError.create(
    "ProviderConnectionCatalogNotFoundError",
    z.object({ profileID: z.string(), catalogProviderID: z.string() }),
  )
  export const AlreadyExists = NamedError.create(
    "ProviderConnectionAlreadyExistsError",
    z.object({ providerID: z.string() }),
  )
  export const NotFound = NamedError.create("ProviderConnectionNotFoundError", z.object({ providerID: z.string() }))
  export const NotManaged = NamedError.create("ProviderConnectionNotManagedError", z.object({ providerID: z.string() }))

  type ProviderConfig = NonNullable<Config.Info["provider"]>[string]

  function enabled(providerID: string, config: Pick<Config.Info, "enabled_providers" | "disabled_providers">) {
    if (config.disabled_providers?.includes(providerID)) return false
    if (config.enabled_providers && !config.enabled_providers.includes(providerID)) return false
    return true
  }

  function configuredEndpoint(provider: ProviderConfig | undefined) {
    return provider?.api ?? (typeof provider?.options?.baseURL === "string" ? provider.options.baseURL : undefined)
  }

  function connectionInfo(providerID: string, config: Config.Info, catalog: Record<string, ModelsDev.Provider>): Info {
    const configured = config.provider?.[providerID]
    const profile = ProviderProfile.resolve(providerID, configured?.profile)
    const profileID = profile?.id ?? configured?.profile ?? configured?.modelsDevProviderID ?? providerID
    const catalogProviderID = configured?.modelsDevProviderID ?? profile?.modelsDevProviderID ?? profileID
    return {
      id: providerID,
      name: configured?.name ?? catalog[providerID]?.name ?? profile?.name ?? providerID,
      profileID,
      catalogProviderID,
      ...(configuredEndpoint(configured) ? { endpoint: configuredEndpoint(configured) } : {}),
      enabled: enabled(providerID, config),
      configured: configured !== undefined,
      removable:
        configured !== undefined &&
        (configured.profile !== undefined || configured.modelsDevProviderID !== undefined) &&
        providerID !== profileID,
    }
  }

  export function listFrom(config: Config.Info, catalog: Record<string, ModelsDev.Provider>): Record<string, Info> {
    const ids = new Set([...Object.keys(catalog), ...Object.keys(config.provider ?? {})])
    return Object.fromEntries([...ids].map((providerID) => [providerID, connectionInfo(providerID, config, catalog)]))
  }

  export async function list(): Promise<Record<string, Info>> {
    const config = await Config.globalResolved()
    const catalog = await ProviderCatalog.resolve({ config, includeLive: false })
    return listFrom(config, catalog)
  }

  function slug(value: string) {
    return value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 64)
  }

  function allocateID(input: CreateInput, occupied: Set<string>) {
    if (input.id) {
      if (occupied.has(input.id)) throw new AlreadyExists({ providerID: input.id })
      return input.id
    }
    const stem = slug(`${input.profileID}-${input.name}`) || slug(`${input.profileID}-account`)
    let providerID = stem
    let suffix = 2
    while (occupied.has(providerID)) {
      const nextSuffix = `-${suffix++}`
      providerID = `${stem.slice(0, 64 - nextSuffix.length)}${nextSuffix}`
    }
    return providerID
  }

  function withEnabledState(config: Config.Info, providerID: string, nextEnabled: boolean): Config.Info {
    const disabled = new Set(config.disabled_providers ?? [])
    const allow = config.enabled_providers ? new Set(config.enabled_providers) : undefined
    if (nextEnabled) {
      disabled.delete(providerID)
      allow?.add(providerID)
    } else {
      disabled.add(providerID)
      allow?.delete(providerID)
    }
    return {
      ...config,
      ...(allow ? { enabled_providers: [...allow] } : {}),
      disabled_providers: [...disabled],
    }
  }

  function withoutEnabledState(config: Config.Info, providerID: string): Config.Info {
    return {
      ...config,
      ...(config.enabled_providers
        ? { enabled_providers: config.enabled_providers.filter((item) => item !== providerID) }
        : {}),
      disabled_providers: (config.disabled_providers ?? []).filter((item) => item !== providerID),
    }
  }

  export async function create(input: CreateInput) {
    const parsed = CreateInput.parse(input)
    using _ = await Lock.write(MUTATION_LOCK)
    const domain = await Config.domainGet("providers")
    const resolved = await Config.globalResolved()
    const catalog = await ProviderCatalog.resolve({ config: resolved, includeLive: false })
    const canonicalProfileID = ProviderProfile.canonicalID(parsed.profileID)
    const profile = ProviderProfile.get(canonicalProfileID)
    const profileID = profile?.id ?? canonicalProfileID
    const catalogProviderID = profile?.modelsDevProviderID ?? profileID
    if (!profile && !catalog[catalogProviderID]) throw new ProfileNotFound({ profileID: parsed.profileID })
    if (!catalog[catalogProviderID]) {
      throw new CatalogNotFound({ profileID, catalogProviderID })
    }
    const occupied = new Set([
      ...Object.keys(catalog),
      ...Object.keys(domain.provider ?? {}),
      ...ProviderProfile.all().map((item) => item.id),
    ])
    const providerID = allocateID({ ...parsed, profileID }, occupied)
    const provider: ProviderConfig = {
      ...(profile ? { profile: profileID } : {}),
      modelsDevProviderID: catalogProviderID,
      name: parsed.name,
      ...(parsed.endpoint ? { api: parsed.endpoint } : {}),
    }
    let next: Config.Info = {
      ...domain,
      provider: {
        ...(domain.provider ?? {}),
        [providerID]: provider,
      },
    }
    next = withEnabledState(next, providerID, parsed.enabled ?? true)
    const { change } = await Config.domainUpdateWithChange("providers", next, { mode: "replace-domain" })
    return {
      connection: connectionInfo(providerID, change.config, catalog),
      change,
    }
  }

  export async function update(providerID: string, input: UpdateInput) {
    const parsedProviderID = z.string().min(1).parse(providerID)
    const parsed = UpdateInput.parse(input)
    using _ = await Lock.write(MUTATION_LOCK)
    const domain = await Config.domainGet("providers")
    const current = domain.provider?.[parsedProviderID]
    if (!current) throw new NotFound({ providerID: parsedProviderID })
    const ownerID = current.profile ?? current.modelsDevProviderID
    if (!ownerID || parsedProviderID === ownerID) throw new NotManaged({ providerID: parsedProviderID })
    const provider: ProviderConfig = {
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    }
    if (parsed.endpoint !== undefined) {
      if (parsed.endpoint === null) delete provider.api
      else provider.api = parsed.endpoint
      if (provider.options && "baseURL" in provider.options) {
        const options = { ...provider.options }
        delete options.baseURL
        if (Object.keys(options).length === 0) delete provider.options
        else provider.options = options
      }
    }
    let next: Config.Info = {
      ...domain,
      provider: {
        ...(domain.provider ?? {}),
        [parsedProviderID]: provider,
      },
    }
    if (parsed.enabled !== undefined) next = withEnabledState(next, parsedProviderID, parsed.enabled)
    const { change } = await Config.domainUpdateWithChange("providers", next, { mode: "replace-domain" })
    const catalog = await ProviderCatalog.resolve({ config: change.config, includeLive: false })
    return {
      connection: connectionInfo(parsedProviderID, change.config, catalog),
      change,
    }
  }

  export async function remove(providerID: string) {
    const parsedProviderID = z.string().min(1).parse(providerID)
    using _ = await Lock.write(MUTATION_LOCK)
    const domain = await Config.domainGet("providers")
    const current = domain.provider?.[parsedProviderID]
    if (!current) throw new NotFound({ providerID: parsedProviderID })
    const ownerID = current.profile ?? current.modelsDevProviderID
    if (!ownerID || parsedProviderID === ownerID) throw new NotManaged({ providerID: parsedProviderID })
    const providers = { ...(domain.provider ?? {}) }
    delete providers[parsedProviderID]
    const next = withoutEnabledState({ ...domain, provider: providers }, parsedProviderID)
    const { change } = await Config.domainUpdateWithChange("providers", next, { mode: "replace-domain" })
    await Auth.remove(parsedProviderID)
    return {
      result: { providerID: parsedProviderID, removed: true as const },
      change,
    }
  }
}
