import { ChannelSetup } from "../setup"
import * as ConnectionsConfigSchema from "@ericsanchezok/synergy-channels/config-schema"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import * as prompts from "@clack/prompts"
import { UI } from "@ericsanchezok/synergy-util/terminal"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { attachOption, ensureServer, fetchChannelApi } from "./channel-server"
import * as ChannelTypes from "../types"

function getStatusIcon(status: ChannelTypes.Status["status"]): string {
  switch (status) {
    case "connected":
      return "✓"
    case "connecting":
      return "◐"
    case "disconnected":
      return "○"
    case "disabled":
      return "○"
    case "failed":
      return "✗"
    default:
      return "?"
  }
}

function getStatusText(status: ChannelTypes.Status): string {
  if (status.status === "failed") return `failed: ${status.error}`
  return status.status
}

function parseChannelKey(key: string): { channelType: string; accountId: string } | null {
  const parts = key.split(":")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { channelType: parts[0], accountId: parts[1] }
}

function printStatuses(statuses: Record<string, ChannelTypes.Status>): void {
  const entries = Object.entries(statuses)
  if (entries.length === 0) {
    prompts.log.warn("No channels configured")
    return
  }
  for (const [key, status] of entries) {
    prompts.log.info(`${getStatusIcon(status.status)} ${key} ${UI.Style.TEXT_DIM}${getStatusText(status)}`)
  }
}

export const ChannelCommand = cmd({
  command: "channel",
  describe: "manage messaging channels",
  builder: (yargs) =>
    yargs
      .command(ChannelStartCommand)
      .command(ChannelStopCommand)
      .command(ChannelStatusCommand)
      .command(ChannelListCommand)
      .command(ChannelAddCommand)
      .demandCommand(),
  async handler() {},
})

export const ChannelStatusCommand = cmd({
  command: "status",
  describe: "show channel connection status",
  builder: (yargs) => yargs.options(attachOption).option("json", { type: "boolean", describe: "output as JSON" }),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const statuses = await fetchChannelApi(serverUrl, "")

    if (args.json) {
      process.stdout.write(JSON.stringify(statuses, null, 2) + "\n")
      return
    }

    UI.empty()
    prompts.intro("Channel Status")
    printStatuses(statuses)
    prompts.outro(`${Object.keys(statuses).length} channel(s)`)
  },
})

export const ChannelStartCommand = cmd({
  command: "start [key]",
  describe: "start or reconnect channels",
  builder: (yargs) =>
    yargs
      .positional("key", {
        type: "string",
        describe: "channel key to start (e.g. feishu:default). Omit to start all.",
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    UI.empty()

    if (args.key) {
      const parsed = parseChannelKey(args.key)
      if (!parsed) {
        UI.error(`Invalid channel key: ${args.key}. Expected format: type:account (e.g. feishu:default)`)
        process.exit(1)
      }
      prompts.intro(`Starting ${args.key}`)
      const statuses = await fetchChannelApi(serverUrl, `/${parsed.channelType}/${parsed.accountId}/start`, "POST")
      printStatuses(statuses)
    } else {
      prompts.intro("Starting all channels")
      const statuses = await fetchChannelApi(serverUrl, "/start", "POST")
      printStatuses(statuses)
    }

    prompts.outro("Done")
  },
})

export const ChannelStopCommand = cmd({
  command: "stop [key]",
  describe: "stop channels",
  builder: (yargs) =>
    yargs
      .positional("key", {
        type: "string",
        describe: "channel key to stop (e.g. feishu:default). Omit to stop all.",
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    UI.empty()

    if (args.key) {
      const parsed = parseChannelKey(args.key)
      if (!parsed) {
        UI.error(`Invalid channel key: ${args.key}. Expected format: type:account (e.g. feishu:default)`)
        process.exit(1)
      }
      prompts.intro(`Stopping ${args.key}`)
      const statuses = await fetchChannelApi(serverUrl, `/${parsed.channelType}/${parsed.accountId}/stop`, "POST")
      printStatuses(statuses)
    } else {
      prompts.intro("Stopping all channels")
      const statuses = await fetchChannelApi(serverUrl, "/stop", "POST")
      printStatuses(statuses)
    }

    prompts.outro("Done")
  },
})

export const ChannelListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list configured channels",
  async handler() {
    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        UI.empty()
        prompts.intro("Channels")

        const cfg = await Config.current()
        const channels = cfg.channel ?? {}
        const entries = Object.entries(channels) as Array<[string, ConnectionsConfigSchema.Channel]>

        if (entries.length === 0) {
          prompts.log.warn("No channels configured")
          prompts.outro("Add channels with: synergy channel add")
          return
        }

        for (const [channelType, channelConfig] of entries) {
          const accounts = channelConfig.accounts
          const accountEntries = Object.entries(accounts)

          if (accountEntries.length === 0) {
            prompts.log.info(`${channelType} ${UI.Style.TEXT_DIM}no accounts`)
            continue
          }

          for (const [accountId, accountConfig] of accountEntries as Array<[string, { enabled?: boolean }]>) {
            const enabled = !("enabled" in accountConfig) || accountConfig.enabled !== false
            const icon = enabled ? "○" : "○"
            const status = enabled ? "configured" : "disabled"
            const domain = "domain" in channelConfig ? channelConfig.domain : undefined

            prompts.log.info(
              `${icon} ${channelType}/${accountId} ${UI.Style.TEXT_DIM}${status}` +
                (domain ? `\n    ${UI.Style.TEXT_DIM}domain: ${domain}` : ""),
            )
          }
        }

        prompts.outro(`${entries.length} channel type(s)`)
      },
    })
  },
})

export const ChannelAddCommand = cmd({
  command: "add [type]",
  describe: "add a channel configuration (writes to global config)",
  builder: (yargs) =>
    yargs
      .positional("type", {
        type: "string",
        describe: "selected channel provider",
        choices: ChannelSetup.list().map((provider) => provider.id),
      })
      .option("print", {
        type: "boolean",
        describe: "print config instead of writing to file",
      })
      .options(attachOption),
  async handler(args) {
    UI.empty()
    prompts.intro("Add Channel")
    if (!ChannelSetup.list().length) {
      prompts.log.warn("No channel providers selected")
      prompts.outro("Done")
      return
    }

    const channelType =
      args.type ??
      (await (async () => {
        const selected = await prompts.select({
          message: "Select channel type",
          options: ChannelSetup.list().map((provider) => ({ label: provider.label, value: provider.id })),
        })
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        return selected
      })())

    const provider = ChannelSetup.get(channelType)
    if (provider) {
      await provider.configure(args.print ?? false, args.attach, printStatuses)
      return
    }
    prompts.log.error(`Unknown channel type: ${channelType}`)
    prompts.outro("Done")
  },
})
