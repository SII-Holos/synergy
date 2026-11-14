import { runCli } from "@ericsanchezok/synergy-cli/main"
import { organization } from "../../src/component"

const component = organization()
const adapter = component.adapters?.cli ? await import(component.adapters.cli.href) : {}
await runCli({
  register: () => component.register(),
  commands: adapter.commands,
  runtimeFactory: async () => {
    throw new Error("Organization commands must not open an Agent Runtime")
  },
})
