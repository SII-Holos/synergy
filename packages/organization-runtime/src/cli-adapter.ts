import type { CommandEntry, CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "member-runtime",
    describe: "serve a prepared member Runtime from a private supervisor request",
    initialization: "owner",
    load: async () => (await import("./cli/member")).MemberRuntimeCommand as unknown as CommandModule,
  },
  {
    command: "hosted-runtime",
    describe: "serve a prepared organization-hosted Runtime from a private supervisor request",
    initialization: "owner",
    load: async () => (await import("./cli/hosted")).HostedRuntimeCommand as unknown as CommandModule,
  },
]
