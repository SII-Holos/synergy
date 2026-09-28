import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { recordedProvider } from "./provider"
import { atomicJSON } from "./evidence"
import { RemoteLab } from "./remote-protocol"

export const Settings = z
  .object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    upstream: z.url(),
    apiKeyFile: z.string().min(1),
    modelCatalog: z.string().min(1),
    config: z.record(z.string(), z.json()),
    deadlineMs: z.number().int().positive().default(600_000),
    remote: RemoteLab.optional(),
    chromium: z.string().optional(),
  })
  .strict()
export type Settings = z.infer<typeof Settings>

export async function prepareRuntime(directory: string, settings: Settings, gateway: { url: string; token: string }) {
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
      MODELS_DEV_API_JSON: path.join(root, "cache", "models.json"),
      SYNERGY_CONFIG_CONTENT: JSON.stringify(config),
    },
  })
  await fs.mkdir(host.env.TMPDIR!, { recursive: true, mode: 0o700 })
  return { home, host, config }
}

export async function acceptanceRuntime(directory: string, settings: Settings) {
  const gateway = await recordedProvider({
    directory,
    provider: settings.providerID,
    upstream: settings.upstream,
    apiKey: (await Bun.file(settings.apiKeyFile).text()).trim(),
  })
  const { home, host } = await prepareRuntime(directory, settings, gateway)
  let runtime
  try {
    runtime = await PresetRuntimeHandle.openTask({ host, mode: "oneshot" })
  } catch (error) {
    await gateway[Symbol.asyncDispose]()
    throw error
  }
  return {
    runtime,
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
