import type { Hooks, PluginInput, Plugin as PluginInstance } from "@ericsanchezok/synergy-plugin"
import path from "path"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { BunProc } from "../util/bun"
import { Instance } from "../scope/instance"
import { Flag } from "../flag/flag"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  const BUILTIN: string[] = []

  const state = Instance.state(async () => {
    const { Server } = await import("../server/server")
    const client = createSynergyClient({
      baseUrl: Server.url().toString(),
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks = []
    const input: PluginInput = {
      client,
      scope: Instance.scope,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }
    const plugins = [...(config.plugin ?? [])]
    if (!Flag.SYNERGY_DISABLE_DEFAULT_PLUGINS) {
      plugins.push(...BUILTIN)
    }
    for (let plugin of plugins) {
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await BunProc.install(pkg, version).catch((err) => {
          if (builtin) return ""
          throw err
        })
        if (!plugin) continue
      } else {
        const filePath = plugin.slice("file://".length)
        if (!path.isAbsolute(filePath)) {
          plugin = "file://" + path.resolve(Instance.directory, filePath)
        }
      }
      const mod = await import(plugin)
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
        if (seen.has(fn)) continue
        seen.add(fn)
        const init = await fn(input)
        hooks.push(init)
      }
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function reload() {
    log.info("reloading plugin state")
    await state.reset()
    log.info("plugin state reloaded")
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
