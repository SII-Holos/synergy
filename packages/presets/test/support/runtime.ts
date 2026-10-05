import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { runInProcessStream } from "@ericsanchezok/synergy-harness/test/support/internals"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { desktopComponents } from "../../src/components"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"

export async function testRuntime(options: { env?: Record<string, string | undefined>; desktop?: boolean } = {}) {
  const fixture = await runtimeHome()
  const host = { ...fixture.host, env: { ...fixture.host.env, ...options.env } }
  try {
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
