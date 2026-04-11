import { Log } from "@/util/log"
import { ExternalAgent } from "./bridge"

export namespace ExternalAgentDiscovery {
  const log = Log.create({ service: "external-agent.discovery" })

  export async function discover(): Promise<Map<string, ExternalAgent.Info>> {
    const results = new Map<string, ExternalAgent.Info>()
    const names = ExternalAgent.listAdapters()

    const settled = await Promise.allSettled(
      names.map(async (name) => {
        const adapter = ExternalAgent.getAdapter(name)
        if (!adapter) return { name, available: false }
        const result = await adapter.discover()
        return { name, ...result }
      }),
    )

    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        log.warn("adapter discovery failed", { error: String(outcome.reason) })
        continue
      }
      const { name, available, path, version } = outcome.value
      if (!available) {
        log.debug("adapter not available", { adapter: name })
        continue
      }
      log.info("discovered adapter", { adapter: name, path, version })
      results.set(name, { adapter: name, path, version })
    }

    log.info("discovery complete", {
      total: names.length,
      available: results.size,
    })
    return results
  }

  export async function discoverOne(name: string): Promise<ExternalAgent.Info | undefined> {
    const adapter = ExternalAgent.getAdapter(name)
    if (!adapter) {
      log.warn("adapter not registered", { adapter: name })
      return undefined
    }

    try {
      const result = await adapter.discover()
      if (!result.available) {
        log.debug("adapter not available", { adapter: name })
        return undefined
      }
      log.info("discovered adapter", {
        adapter: name,
        path: result.path,
        version: result.version,
      })
      return { adapter: name, path: result.path, version: result.version }
    } catch (e) {
      log.warn("adapter discovery failed", {
        adapter: name,
        error: String(e),
      })
      return undefined
    }
  }
}
