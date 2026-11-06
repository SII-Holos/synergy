import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerBrowser } from "../../src/register"
import { disposeBrowser } from "../../src/register"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"

export function testRuntime(register?: () => void, env?: Record<string, string | undefined>) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerBrowser()
        register?.()
        if (!EnvironmentProviders.list().some((provider) => provider.id === "native")) {
          EnvironmentProviders.register({
            id: "native",
            allocate: async () => {
              throw Error("Browser fixture must not allocate compute")
            },
            inspect: async () => ({ state: "absent" }),
            deallocate: async () => {},
          })
          EnvironmentProviders.setDefault({ provider: "native", spec: {} })
        }
      },
      services: () => ({ disposeExtensions: disposeBrowser }),
    },
  })
}
