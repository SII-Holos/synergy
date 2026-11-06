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

  const repositories = await prompts.text({
    message: "Repositories to watch (comma-separated, owner/repo)",
    placeholder: "owner/repo1, owner/repo2",
    validate: (x) =>
      x && x.split(",").every((part) => part.trim().match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
        ? undefined
        : "Use owner/repo form, comma-separated",
  })
  if (prompts.isCancel(repositories)) throw new UI.CancelledError()

  const workspaceDir = await prompts.text({
    message: "Workspace directory for checkouts (relative to data home)",
    placeholder: "github-workspaces",
    initialValue: "github-workspaces",
    validate: (x) => (x && x.trim().length > 0 ? undefined : "Required"),
  })
  if (prompts.isCancel(workspaceDir)) throw new UI.CancelledError()

  const autoReview = await prompts.confirm({
    message: "Automatically review new and updated pull requests?",
    initialValue: true,
  })
  if (prompts.isCancel(autoReview)) throw new UI.CancelledError()

  const autoRespond = await prompts.confirm({
    message: "Respond to @mentions of the bot handle and questions?",
    initialValue: true,
  })
  if (prompts.isCancel(autoRespond)) throw new UI.CancelledError()

  const config: Config.Info = {
    channel: {
      github: {
        type: "github" as const,
        accounts: {
          [accountId]: {
            enabled: true,
            repositories: repositories
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean),
            workspaceDir: workspaceDir.trim(),
            workspaceTtlHours: 24,
            pollingIntervalMs: 300_000,
            autoReview,
            autoRespond,
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
    prompts.log.success(`Added github/${accountId} to global channel config`)
    prompts.log.info(`Config file: ${ConfigDomain.filepath("channels")}`)

    const connection = await startChannelIfServerRunning({
      serverUrl,
      channelType: "github",
      accountId,
    })
    if (connection.kind === "connected") {
      prompts.log.success(`Connected github/${accountId} to the running server`)
      printStatuses(connection.statuses)
    } else if (connection.kind === "failed") {
      prompts.log.warn(`Could not connect github/${accountId} to the running server: ${connection.error}`)
      prompts.log.info("The config was saved successfully. You can retry with: synergy channel start github:default")
    } else {
      prompts.log.info("GitHub channel configured — will auto-connect on next server start")
    }
  }

  prompts.log.info("GitHub App credentials are read from SYNERGY_GITHUB_APP_ID and SYNERGY_GITHUB_APP_PRIVATE_KEY")
  prompts.outro("Done")
}
