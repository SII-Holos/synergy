import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { performHolosLogin } from "../../holos/login"
import { HolosAuth } from "../../holos/auth"
import { HolosProfile } from "../../holos/profile"
import { attachOption, ensureServer, fetchHolosApi } from "./holos-server"
import { Server } from "../../server/server"

const statusOrder = ["connected", "connecting", "disconnected", "disabled", "failed", "unknown"] as const

type HolosStatus =
  | { status: "connected"; agentId?: string | null; peerId?: string | null }
  | { status: "connecting"; agentId?: string | null; peerId?: string | null }
  | { status: "disconnected"; agentId?: string | null; peerId?: string | null }
  | { status: "disabled"; agentId?: string | null; peerId?: string | null }
  | { status: "unknown"; agentId?: string | null; peerId?: string | null }
  | { status: "failed"; error?: string; agentId?: string | null; peerId?: string | null }
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
    case "unknown":
      return "?"
  }
}

function getStatusText(status: HolosStatus): string {
  if (status.status === "failed") return `failed: ${status.error}`
  return status.status
}

function printStatus(status: HolosStatus) {
  const id = status.agentId ?? status.peerId
  if (!id) {
    prompts.log.warn("No active Holos account configured")
    return
  }

  prompts.log.info(`${getStatusIcon(status.status)} ${id} ${UI.Style.TEXT_DIM}${getStatusText(status)}`)
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

async function importExistingHolosCredentials(input: { agentSecret: string; expectedAgentId?: string }) {
  let me: HolosProfile.MeInfo
  try {
    me = await HolosProfile.getMe({ agentSecret: input.agentSecret })
  } catch (err) {
    prompts.log.error(`Credential validation failed: ${err instanceof Error ? err.message : String(err)}`)
    prompts.outro("Login failed")
    return false
  }

  if (input.expectedAgentId && me.agentId !== input.expectedAgentId) {
    prompts.log.error(`Credential validation failed: secret belongs to ${me.agentId}, not ${input.expectedAgentId}`)
    prompts.outro("Login failed")
    return false
  }

  await HolosAuth.saveCredentialsAndConfigure(me.agentId, input.agentSecret)
  await finishHolosLogin(me.agentId)
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
      .demandCommand(),
  async handler() {},
})

export async function runHolosLoginFlow(options?: { agentId?: string; agentSecret?: string }) {
  UI.empty()
  prompts.intro("Holos Login")

  if (options?.agentId || options?.agentSecret) {
    if (!options.agentSecret) {
      prompts.log.error("`--agent-secret` is required to import an existing Holos agent")
      prompts.outro("Login failed")
      return
    }

    await importExistingHolosCredentials({
      agentSecret: options.agentSecret,
      expectedAgentId: options.agentId,
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
    const agentSecret = await prompts.password({ message: "Agent Secret:" })
    if (prompts.isCancel(agentSecret) || !agentSecret) {
      prompts.outro("Cancelled")
      return
    }

    await importExistingHolosCredentials({ agentSecret })
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
        describe: "optional expected Holos agent ID when importing a secret",
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

    const status = await fetchHolosApi<HolosStatus>({ serverUrl, path: "/status" })
    if (args.json) {
      process.stdout.write(JSON.stringify(status, null, 2) + "\n")
      return
    }

    UI.empty()
    prompts.intro("Holos Status")
    printStatus(status)
    prompts.outro(status.agentId ? "1 active account" : "No active account")
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
