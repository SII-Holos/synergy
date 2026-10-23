import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { runInProcessStream } from "@ericsanchezok/synergy-harness/test/support/internals"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { desktopComponents } from "../../src/components"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import path from "node:path"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"

export async function testRuntime(
  options: { home?: string; env?: Record<string, string | undefined>; desktop?: boolean; optIn?: string[] } = {},
) {
  const fixture = await runtimeHome({ home: options.home })
  const host = { ...fixture.host, env: { ...fixture.host.env, ...options.env } }
  try {
    if (options.optIn)
      await Bun.write(
        path.join(host.root, "config/synergy.d/140-features.jsonc"),
        JSON.stringify({ features: { optIn: options.optIn } }),
      )
    const runtime = options.desktop
      ? await openAgentRuntime({
          host,
          home: host.root,
          mode: "oneshot",
          listen: false,
          components: [localRuntime({ workers: false }), plugins(), ...(await desktopComponents())],
        })
      : await PresetRuntimeHandle.openTask({ host, mode: "oneshot" })
    runtime.run(() => AgentTurn.setInProcessStream(runInProcessStream))
    let closing: Promise<void> | undefined
    const close = () => (closing ??= runtime.close().finally(() => fixture[Symbol.asyncDispose]()))
    return { ...runtime, host, close, [Symbol.asyncDispose]: close }
  } catch (error) {
    await fixture[Symbol.asyncDispose]()
    throw error
  }
}
