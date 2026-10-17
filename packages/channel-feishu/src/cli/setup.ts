import * as prompts from "@clack/prompts"
import { UI } from "@ericsanchezok/synergy-util/terminal"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { startChannelIfServerRunning } from "@ericsanchezok/synergy-channels/channel/cli/channel-server"
import type { ChannelSetup } from "@ericsanchezok/synergy-channels/channel/setup"
export async function configure(
  printOnly: boolean,
  serverUrl: string,
  printStatuses: ChannelSetup.PrintStatuses,
): Promise<void> {
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
        responseFormat: "markdown" as const,
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
    prompts.log.success(`Added feishu/${accountId} to global channel config`)
    prompts.log.info(`Config file: ${ConfigDomain.filepath("channels")}`)

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
