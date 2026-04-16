import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Instance } from "../../scope/instance"
import { Scope } from "@/scope"
import { attachOption, ensureServer, fetchChannelApi, startChannelIfServerRunning } from "./channel-server"
import * as ChannelTypes from "../../channel/types"

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
    await Instance.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      async fn() {
        UI.empty()
        prompts.intro("Channels")

        const cfg = await Config.get()
        const channels = cfg.channel ?? {}
        const entries = Object.entries(channels) as Array<[string, Config.Channel]>

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

          for (const [accountId, accountConfig] of accountEntries as Array<[string, Config.ChannelFeishuAccount]>) {
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
        describe: "channel type (feishu)",
        choices: ["feishu"],
      })
      .option("print", {
        type: "boolean",
        describe: "print config instead of writing to file",
      })
      .options(attachOption),
  async handler(args) {
    UI.empty()
    prompts.intro("Add Channel")

    const channelType =
      args.type ??
      (await (async () => {
        const selected = await prompts.select({
          message: "Select channel type",
          options: [{ label: "Feishu / Lark", value: "feishu", hint: "飞书 / Lark" }],
        })
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        return selected
      })())

    if (channelType === "feishu") {
      await addFeishuChannel(args.print ?? false, args.attach)
      return
    }

    prompts.log.error(`Unknown channel type: ${channelType}`)
    prompts.outro("Done")
  },
})

async function addFeishuChannel(printOnly: boolean, serverUrl: string): Promise<void> {
  const accountId = await prompts.text({
    message: "Account name",
    placeholder: "e.g., work, personal",
    initialValue: "default",
    validate: (x) => (x && x.match(/^[a-z0-9-]+$/) ? undefined : "lowercase letters, numbers, hyphens only"),
  })
  if (prompts.isCancel(accountId)) throw new UI.CancelledError()

  const appId = await prompts.text({
    message: "App ID",
    placeholder: "cli_xxxx",
    validate: (x) => (x && x.length > 0 ? undefined : "Required"),
  })
  if (prompts.isCancel(appId)) throw new UI.CancelledError()

  const useEnv = await prompts.confirm({
    message: "Store App Secret in environment variable?",
    initialValue: true,
  })
  if (prompts.isCancel(useEnv)) throw new UI.CancelledError()

  const appSecret = useEnv
    ? "{env:FEISHU_APP_SECRET}"
    : await (async () => {
        const secret = await prompts.password({
          message: "App Secret",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(secret)) throw new UI.CancelledError()
        return secret
      })()

  const domain = await prompts.select({
    message: "Domain",
    options: [
      { label: "Feishu (国内)", value: "feishu" },
      { label: "Lark (海外)", value: "lark" },
    ],
  })
  if (prompts.isCancel(domain)) throw new UI.CancelledError()

  const allowDM = await prompts.confirm({
    message: "Allow direct messages?",
    initialValue: true,
  })
  if (prompts.isCancel(allowDM)) throw new UI.CancelledError()

  const allowGroup = await prompts.confirm({
    message: "Allow group messages?",
    initialValue: true,
  })
  if (prompts.isCancel(allowGroup)) throw new UI.CancelledError()

  const requireMention = allowGroup
    ? await (async () => {
        const result = await prompts.confirm({
          message: "Require @mention in groups?",
          initialValue: true,
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        return result
      })()
    : true

  const config: Config.Info = {
    channel: {
      feishu: {
        type: "feishu" as const,
        domain,
        streaming: true,
        accounts: {
          [accountId]: {
            enabled: true,
            appId,
            appSecret,
            allowDM,
            allowGroup,
            requireMention,
            streaming: true,
            streamingThrottleMs: 100,
            groupSessionScope: "group" as const,
            inboundDebounceMs: 0,
            resolveSenderNames: true,
            replyInThread: false,
          },
        },
      },
    },
  }

  if (printOnly) {
    prompts.log.success("Channel configured!")
    prompts.log.info("Add this to your config file:")
    prompts.log.message(JSON.stringify(config, null, 2))
  } else {
    await Config.updateGlobal(config)
    prompts.log.success(`Added feishu/${accountId} to the active global Config Set`)
    prompts.log.info(`Config file: ${await Config.globalPath()}`)
    prompts.log.info(`Edit with: synergy config edit`)

    const connection = await startChannelIfServerRunning({
      serverUrl,
      channelType: "feishu",
      accountId,
    })
    if (connection.kind === "connected") {
      prompts.log.success(`Connected feishu/${accountId} to the running server`)
      printStatuses(connection.statuses)
    } else if (connection.kind === "failed") {
      prompts.log.warn(`Could not connect feishu/${accountId} to the running server: ${connection.error}`)
      prompts.log.info("The config was saved successfully. You can retry with: synergy channel start feishu:default")
    } else {
      prompts.log.info("Feishu channel configured — will auto-connect on next server start")
    }
  }

  if (useEnv) {
    UI.empty()
    prompts.log.info("Set the environment variable:")
    prompts.log.message(`export FEISHU_APP_SECRET="your-app-secret"`)
  }

  prompts.outro("Done")
}
