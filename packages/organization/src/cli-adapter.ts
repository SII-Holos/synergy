import type { CommandEntry, CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "org",
    describe: "initialize or serve an organization in an explicit SYNERGY_HOME",
    initialization: "owner",
    load: async () => (await import("./cli/organization")).OrganizationCommand as unknown as CommandModule,
  },
]
