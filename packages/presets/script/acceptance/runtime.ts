import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime"
import type { RuntimeStorage } from "@ericsanchezok/synergy-harness/lifecycle"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { recordedProvider } from "./provider"
import { atomicJSON } from "./evidence"
import { type Settings, validateCatalog } from "./settings"

export async function prepareRuntime(directory: string, settings: Settings, gateway: { url: string; token: string }) {
  await validateCatalog(settings)
  const home = path.join(directory, "home")
  const root = path.join(home, ".synergy")
  await fs.mkdir(path.join(root, "cache"), { recursive: true, mode: 0o700 })
  await fs.copyFile(settings.modelCatalog, path.join(root, "cache", "models.json"))
  const provider = z.record(z.string(), z.record(z.string(), z.json())).parse(settings.config.provider ?? {})
  const selected = provider[settings.providerID] ?? {}
  const options = z.record(z.string(), z.json()).parse(selected.options ?? {})
  const config = {
    ...settings.config,
    provider: {
      ...provider,
      [settings.providerID]: { ...selected, options: { ...options, baseURL: gateway.url, apiKey: gateway.token } },
    },
  }
  await atomicJSON(path.join(directory, "effective-config.json"), config)
  const host = createLocalHost({
    home,
    env: {
      PATH: process.env.PATH,
      TMPDIR: path.join(directory, "tmp"),
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      SYNERGY_HOME: home,
      SYNERGY_TEST_HOME: home,
      SYNERGY_DISABLE_MODELS_FETCH: "1",
      MODELS_DEV_API_JSON: settings.modelCatalog,
      SYNERGY_CONFIG_CONTENT: JSON.stringify(config),
    },
  })
  await fs.mkdir(host.env.TMPDIR!, { recursive: true, mode: 0o700 })
  return { home, host, config }
}

export async function acceptanceRuntime(directory: string, settings: Settings, storage?: RuntimeStorage) {
  const gateway = await recordedProvider({
    directory,
    provider: settings.providerID,
    upstream: settings.upstream,
    apiKey: (await Bun.file(settings.apiKeyFile).text()).trim(),
  })
  let runtime
  let home: string
  try {
    const prepared = await prepareRuntime(directory, settings, gateway)
    home = prepared.home
    runtime = await PresetRuntimeHandle.openTask({ host: prepared.host, mode: "oneshot", storage })
  } catch (error) {
    await gateway[Symbol.asyncDispose]()
    throw error
  }
  return {
    runtime,
    recorder: gateway,
    home,
    model: { providerID: settings.providerID, modelID: settings.modelID },
    async [Symbol.asyncDispose]() {
      try {
        await runtime.close()
      } finally {
        await gateway[Symbol.asyncDispose]()
      }
    },
  }
}

export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, deadlineMs: number): Promise<T> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error("Acceptance state did not reach its declared barrier")
    await Bun.sleep(50)
  }
}
