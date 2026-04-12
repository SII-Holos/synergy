import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { performHolosLogin } from "../../holos/login"
import { HolosAuth } from "../../holos/auth"
import { attachOption, ensureServer, fetchHolosApi } from "./holos-server"
import { Server } from "../../server/server"

const statusOrder = ["connected", "connecting", "disconnected", "disabled", "failed"] as const

type HolosStatus =
  | { status: "connected" }
  | { status: "connecting" }
  | { status: "disconnected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }

function getStatusIcon(status: HolosStatus["status"]): string {
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
  }
}

function getStatusText(status: HolosStatus): string {
  if (status.status === "failed") return `failed: ${status.error}`
  return status.status
}

function printStatusMap(statuses: Record<string, HolosStatus>) {
  const entries = Object.entries(statuses).sort((a, b) => {
    const aIndex = statusOrder.indexOf(a[1].status)
    const bIndex = statusOrder.indexOf(b[1].status)
    return aIndex - bIndex || a[0].localeCompare(b[0])
  })

  if (entries.length === 0) {
    prompts.log.warn("No Holos runtime accounts configured")
    return
  }

  for (const [key, status] of entries) {
    prompts.log.info(`${getStatusIcon(status.status)} ${key} ${UI.Style.TEXT_DIM}${getStatusText(status)}`)
  }
}

async function reconnectHolosIfServerRunning(
  serverUrl: string,
): Promise<{ kind: "connected" } | { kind: "unavailable" } | { kind: "failed"; error: string }> {
  if (!(await ensureServer(serverUrl))) {
    return { kind: "unavailable" }
  }

  try {
    await fetchHolosApi<{ success: true }>({ serverUrl, path: "/reconnect", method: "POST" })
    return { kind: "connected" }
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) }
  }
}

async function finishHolosLogin(agentId: string) {
  prompts.log.success(`Logged in as ${agentId}`)

  const connection = await reconnectHolosIfServerRunning(Server.DEFAULT_URL)
  if (connection.kind === "connected") {
    prompts.log.success("Holos connected to the running server")
  } else if (connection.kind === "failed") {
    prompts.log.warn(`Holos save succeeded, but live reconnect failed: ${connection.error}`)
  } else {
    prompts.log.info("Holos configured — will auto-connect on next server start")
  }

  prompts.outro("Done")
}

async function importExistingHolosCredentials(input: { agentId: string; agentSecret: string }) {
  const result = await HolosAuth.verifyCredentials(input.agentSecret)
  if (!result.valid) {
    prompts.log.error(`Credential validation failed: ${result.reason}`)
    prompts.outro("Login failed")
    return false
  }

  await HolosAuth.saveCredentialsAndConfigure(input.agentId, input.agentSecret)
  await finishHolosLogin(input.agentId)
  return true
}

export const HolosCommand = cmd({
  command: "holos",
  describe: "manage Holos identity and runtime",
  builder: (yargs) =>
    yargs
      .command(HolosLoginCommand)
      .command(HolosStatusCommand)
      .command(HolosVerifyCommand)
      .command(HolosReconnectCommand)
      .command(HolosLogoutCommand)
      .command(HolosCredentialsCommand)
      .command(HolosProfileCommand)
      .demandCommand(),
  async handler() {},
})

export async function runHolosLoginFlow(options?: { agentId?: string; agentSecret?: string }) {
  UI.empty()
  prompts.intro("Holos Login")

  if (options?.agentId || options?.agentSecret) {
    if (!options.agentId || !options.agentSecret) {
      prompts.log.error("`--agent-id` and `--agent-secret` must be provided together")
      prompts.outro("Login failed")
      return
    }

    await importExistingHolosCredentials({
      agentId: options.agentId,
      agentSecret: options.agentSecret,
    })
    return
  }

  const mode = await prompts.select({
    message: "How would you like to log in?",
    options: [
      { value: "create", label: "Create a new agent via Holos" },
      { value: "existing", label: "I already have agent credentials" },
    ],
    initialValue: "create",
  })
  if (prompts.isCancel(mode)) {
    prompts.outro("Cancelled")
    return
  }

  if (mode === "existing") {
    const agentId = await prompts.text({ message: "Agent ID:" })
    if (prompts.isCancel(agentId) || !agentId) {
      prompts.outro("Cancelled")
      return
    }

    const agentSecret = await prompts.password({ message: "Agent Secret:" })
    if (prompts.isCancel(agentSecret) || !agentSecret) {
      prompts.outro("Cancelled")
      return
    }

    await importExistingHolosCredentials({ agentId, agentSecret })
    return
  }

  const result = await performHolosLogin()
  if (!result) {
    prompts.outro("Login cancelled or failed")
    return
  }

  await finishHolosLogin(result.agentId)
}

export const HolosLoginCommand = cmd({
  command: "login",
  describe: "bind to Holos platform",
  builder: (yargs) =>
    yargs
      .option("agent-id", {
        type: "string",
        describe: "log in with an existing Holos agent ID",
      })
      .option("agent-secret", {
        type: "string",
        describe: "log in with an existing Holos agent secret",
      }),
  async handler(args) {
    await runHolosLoginFlow({
      agentId: typeof args.agentId === "string" ? args.agentId : undefined,
      agentSecret: typeof args.agentSecret === "string" ? args.agentSecret : undefined,
    })
  },
})

export const HolosStatusCommand = cmd({
  command: "status",
  describe: "show Holos runtime status",
  builder: (yargs) => yargs.options(attachOption).option("json", { type: "boolean", describe: "output as JSON" }),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const statuses = await fetchHolosApi<Record<string, HolosStatus>>({ serverUrl, path: "/status" })
    if (args.json) {
      process.stdout.write(JSON.stringify(statuses, null, 2) + "\n")
      return
    }

    UI.empty()
    prompts.intro("Holos Status")
    printStatusMap(statuses)
    prompts.outro(`${Object.keys(statuses).length} account(s)`)
  },
})

export const HolosVerifyCommand = cmd({
  command: "verify",
  describe: "verify stored Holos credentials",
  builder: (yargs) => yargs.options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    UI.empty()
    prompts.intro("Verify Holos Credentials")
    try {
      const result = await fetchHolosApi<{ valid: true; agentId: string }>({ serverUrl, path: "/verify" })
      prompts.log.success(`Credentials valid for ${result.agentId}`)
      prompts.outro("Done")
    } catch (error) {
      prompts.log.error(error instanceof Error ? error.message : String(error))
      prompts.outro("Verification failed")
      process.exitCode = 1
    }
  },
})

export const HolosReconnectCommand = cmd({
  command: "reconnect",
  describe: "reload the Holos runtime connection",
  builder: (yargs) => yargs.options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    UI.empty()
    prompts.intro("Reconnect Holos")
    await fetchHolosApi<{ success: true }>({ serverUrl, path: "/reconnect", method: "POST" })
    prompts.outro("Reconnect requested")
  },
})

export const HolosLogoutCommand = cmd({
  command: "logout",
  describe: "clear Holos credentials and stop the runtime",
  builder: (yargs) => yargs.options(attachOption),
  async handler(args) {
    const confirm = await prompts.confirm({
      message: "Clear stored Holos credentials and stop the Holos runtime?",
      initialValue: false,
    })
    if (prompts.isCancel(confirm) || !confirm) {
      prompts.outro("Cancelled")
      return
    }

    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    await fetchHolosApi<{ success: true }>({ serverUrl, path: "/credentials", method: "DELETE" })
    prompts.outro("Holos credentials cleared")
  },
})

export const HolosCredentialsCommand = cmd({
  command: "credentials",
  describe: "show local Holos credential status",
  builder: (yargs) => yargs.options(attachOption).option("json", { type: "boolean", describe: "output as JSON" }),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const result = await fetchHolosApi<{ exists: boolean; agentId?: string; maskedSecret?: string }>({
      serverUrl,
      path: "/credentials/status",
    })

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      return
    }

    UI.empty()
    prompts.intro("Holos Credentials")
    if (!result.exists) {
      prompts.log.warn("No Holos credentials stored")
      prompts.outro("Use: synergy holos login")
      return
    }

    prompts.log.info(`Agent ID ${UI.Style.TEXT_DIM}${result.agentId ?? "unknown"}`)
    prompts.log.info(`Secret   ${UI.Style.TEXT_DIM}${result.maskedSecret ?? "unknown"}`)
    prompts.outro("Done")
  },
})

export const HolosProfileCommand = cmd({
  command: "profile",
  describe: "manage the local Holos profile",
  builder: (yargs) =>
    yargs
      .command(HolosProfileShowCommand)
      .command(HolosProfileResetCommand)
      .command(HolosProfileSkipGenesisCommand)
      .demandCommand(),
  async handler() {},
})

export const HolosProfileShowCommand = cmd({
  command: "show",
  describe: "show the current Holos profile",
  builder: (yargs) => yargs.options(attachOption).option("json", { type: "boolean", describe: "output as JSON" }),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const result = await fetchHolosApi<{
      agentId: string | null
      profile: { name: string; bio: string; avatar?: string } | null
    }>({
      serverUrl,
      path: "/profile",
    })

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      return
    }

    UI.empty()
    prompts.intro("Holos Profile")
    prompts.log.info(`Agent ID ${UI.Style.TEXT_DIM}${result.agentId ?? "not bound"}`)
    if (!result.profile) {
      prompts.log.warn("No Holos profile initialized")
      prompts.outro("Done")
      return
    }
    prompts.log.info(`Name     ${UI.Style.TEXT_DIM}${result.profile.name}`)
    prompts.log.info(`Bio      ${UI.Style.TEXT_DIM}${result.profile.bio}`)
    prompts.log.info(`Avatar   ${UI.Style.TEXT_DIM}${result.profile.avatar ?? "none"}`)
    prompts.outro("Done")
  },
})

export const HolosProfileResetCommand = cmd({
  command: "reset",
  describe: "reset Holos profile initialization state",
  builder: (yargs) => yargs.options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    await fetchHolosApi<boolean>({ serverUrl, path: "/profile/reset", method: "POST" })
    prompts.outro("Holos profile initialization reset")
  },
})

export const HolosProfileSkipGenesisCommand = cmd({
  command: "skip-genesis",
  describe: "create the default Holos profile without onboarding chat",
  builder: (yargs) => yargs.options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    await fetchHolosApi({ serverUrl, path: "/profile/skip-genesis", method: "POST" })
    prompts.outro("Holos genesis skipped")
  },
})
