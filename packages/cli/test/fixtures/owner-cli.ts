import { runCli } from "../../src/main"
import { currentMaintenance } from "../../src/cli/maintenance-progress"

await runCli({
  commandsOnly: true,
  name: "owner-fixture",
  register() {},
  runtimeFactory: async () => {
    throw new Error("An owner CLI cannot open an Agent Runtime")
  },
  commands: [
    {
      command: "migration <action>",
      describe: "run service-owned maintenance",
      initialization: "owner",
      load: async () => ({
        command: "migration <action>",
        builder: (yargs) => yargs.option("maintenance", { type: "boolean" }),
        handler() {
          console.log(currentMaintenance() ? "ambient-maintenance" : "owner-maintenance")
        },
      }),
    },
    {
      command: "independent",
      describe: "operate an independent service",
      initialization: "owner",
      load: async () => ({
        command: "independent",
        handler() {
          console.log("owner-ready")
        },
      }),
    },
  ],
})
