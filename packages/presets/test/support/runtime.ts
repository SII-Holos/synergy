import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { runInProcessStream } from "@ericsanchezok/synergy-harness/test/support/internals"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

export async function testRuntime(options: { env?: Record<string, string | undefined> } = {}) {
  const fixture = await runtimeHome()
  const host = { ...fixture.host, env: { ...fixture.host.env, ...options.env } }
  try {
    const runtime = await PresetRuntimeHandle.openTask({ host, mode: "oneshot" })
    runtime.run(() => AgentTurn.setInProcessStream(runInProcessStream))
    let closing: Promise<void> | undefined
    const close = () => (closing ??= runtime.close().finally(() => fixture[Symbol.asyncDispose]()))
    return { ...runtime, host, close, [Symbol.asyncDispose]: close }
  } catch (error) {
    await fixture[Symbol.asyncDispose]()
    throw error
  }
}
