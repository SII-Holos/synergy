import { z } from "zod"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Auth } from "@ericsanchezok/synergy-harness/provider/api-key"
import { ProviderConnection } from "@ericsanchezok/synergy-harness/provider/connection"
import { listProvidersForClient, ProviderListResponse } from "./provider-view"
import { NamedError } from "@ericsanchezok/synergy-util/error"

export namespace ProviderDirectory {
  export const ModelKey = z.object({ providerID: z.string(), modelID: z.string() })
  export type ModelKey = z.infer<typeof ModelKey>
  export const Selection = ProviderListResponse.extend({ complete: z.literal(false), version: z.string() }).meta({
    ref: "ProviderSelection",
  })
  export const ModelEntry = z
    .object({ providerID: z.string(), model: Provider.Model })
    .meta({ ref: "ProviderDirectoryModel" })
  export const Page = z
    .object({ version: z.string(), models: ModelEntry.array(), nextCursor: z.string().optional(), total: z.number() })
    .meta({ ref: "ProviderDirectoryPage" })
  export const Conflict = NamedError.create("ProviderDirectoryConflict", z.object({ message: z.string() }))
  const cache = RuntimeContext.state(
    () => new WeakMap<Config.Info, { fingerprint: string; expires: number; value: ReturnType<typeof build> }>(),
  )

  function displayModel(model: Provider.Model): Provider.Model {
    return {
      ...model,
      options: {},
      headers: {},
      variants: model.variants && Object.fromEntries(Object.keys(model.variants).map((key) => [key, {}])),
    }
  }

  async function build() {
    const data = await listProvidersForClient()
    const models = data.all
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({ providerID: provider.id, model: displayModel(model) })),
      )
      .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.model.id.localeCompare(b.model.id))
    const version = new Bun.CryptoHasher("sha256").update(JSON.stringify(data)).digest("hex")
    return { data, models, version }
  }

  async function current() {
    const [config, auth, connections] = await Promise.all([Config.current(), Auth.entries(), ProviderConnection.list()])
    const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify([auth, connections])).digest("hex")
    const entries = cache()
    const existing = entries.get(config)
    if (existing && existing.expires > Date.now() && existing.fingerprint === fingerprint) return existing.value
    const value = build()
    const entry = { fingerprint, expires: Date.now() + 5_000, value }
    entries.set(config, entry)
    void value.catch(() => {
      if (entries.get(config) === entry) entries.delete(config)
    })
    return value
  }

  export async function selection(keys: ModelKey[]) {
    const { data, version } = await current()
    const selected = new Set(keys.map((key) => JSON.stringify([key.providerID, key.modelID])))
    for (const providerID of data.connected)
      if (data.default[providerID]) selected.add(JSON.stringify([providerID, data.default[providerID]]))
    return {
      ...data,
      complete: false as const,
      version,
      all: data.all.map((provider) => ({
        ...provider,
        key: undefined,
        options: {},
        models: Object.fromEntries(
          Object.entries(provider.models)
            .filter(([id]) => selected.has(JSON.stringify([provider.id, id])))
            .map(([id, model]) => [id, displayModel(model)]),
        ),
      })),
    }
  }

  export async function byID(keys: ModelKey[]) {
    const { data, version } = await current()
    const models = keys.flatMap((key) => {
      const model = data.all.find((provider) => provider.id === key.providerID)?.models[key.modelID]
      return model ? [{ providerID: key.providerID, model: displayModel(model) }] : []
    })
    return { version, models }
  }

  export async function page(input: {
    cursor?: string
    limit?: number
    query?: string
    providerID?: string
    connectedOnly?: boolean
  }) {
    const { data, models, version } = await current()
    const query = input.query?.normalize("NFC").toLowerCase() ?? ""
    const filter = JSON.stringify([query, input.providerID, input.connectedOnly ?? false])
    let offset = 0
    if (input.cursor) {
      let cursor: { version: string; filter: string; offset: number }
      try {
        cursor = z
          .object({ version: z.string(), filter: z.string(), offset: z.number().int().nonnegative() })
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()))
      } catch {
        throw new Conflict({ message: "Invalid model directory cursor" })
      }
      if (cursor.version !== version || cursor.filter !== filter)
        throw new Conflict({ message: "Model directory changed; restart pagination" })
      offset = cursor.offset
    }
    const matching = models.filter(
      (entry) =>
        (!input.providerID || entry.providerID === input.providerID) &&
        (!input.connectedOnly || data.connected.includes(entry.providerID)) &&
        (!query ||
          `${entry.providerID}\n${entry.model.id}\n${entry.model.name}`.normalize("NFC").toLowerCase().includes(query)),
    )
    const limit = Math.max(1, Math.min(100, input.limit ?? 100))
    const items: typeof models = []
    let bytes = 256
    for (const entry of matching.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(entry))
      if (size > 256 * 1024 - 1024)
        throw new Conflict({ message: "A model directory entry exceeds the display budget" })
      if (bytes + size > 256 * 1024) break
      items.push(entry)
      bytes += size
    }
    const next = offset + items.length
    return {
      version,
      models: items,
      total: matching.length,
      nextCursor:
        next < matching.length
          ? Buffer.from(JSON.stringify({ version, filter, offset: next })).toString("base64url")
          : undefined,
    }
  }
}
