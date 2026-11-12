import { EnvironmentOrigin } from "../../src/environment/origin"
import { testRuntime } from "./runtime"

export async function testEnvironmentRuntime(options: Parameters<typeof testRuntime>[0] = {}, open = testRuntime) {
  const host: { port?: ReturnType<typeof EnvironmentOrigin.registerHost> } = {}
  const runtime = await open({
    ...options,
    register() {
      host.port = EnvironmentOrigin.registerHost("environment-test-host")
      options.register?.()
    },
  })
  return {
    ...runtime,
    origin(invocationID: string) {
      if (!host.port) throw new Error("Environment test Host was not composed")
      return host.port.capture(invocationID)
    },
  }
}
