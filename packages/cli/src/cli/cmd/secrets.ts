import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../../util/ui"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"

function fingerprintLabel(entry: { fingerprint: { length: number } }) {
  return `${entry.fingerprint.length} chars`
}

function sourceLabel(entry: { source: SecretVault.Source }) {
  const source = entry.source
  if (source.kind === "heuristic") return `heuristic:${source.context}`
  if (source.kind === "reference") return `reference:${source.type}`
  if (source.kind === "config") return `config${source.path ? ` (${source.path})` : ""}`
  return source.kind
}

export const SecretsListCommand = cmd({
  command: "list",
  describe: "list registered secret vault entries",
  async handler() {
    const entries = await SecretVault.list()
    if (entries.length === 0) {
      UI.println("No secrets registered.")
      return
    }
    for (const entry of entries) {
      UI.println(
        `${entry.id}  ${fingerprintLabel(entry).padEnd(12)} source=${sourceLabel(entry).padEnd(28)} resolves=${entry.resolvedCount}`,
      )
    }
  },
})

export const SecretsRegisterCommand = cmd({
  command: "register",
  describe: "register a secret value (read from a hidden prompt)",
  builder: (yargs) =>
    yargs.option("policy-tools", {
      type: "array",
      describe: "Restrict which tools may resolve this secret; can be repeated",
    }),
  async handler(argv) {
    const value = await prompts.password({ message: "Secret value" })
    if (prompts.isCancel(value) || !value) throw new UI.CancelledError()
    const tools = (argv["policy-tools"] as string[] | undefined)?.filter(Boolean)
    const entry = await SecretVault.register(value, { kind: "user" }, tools?.length ? { policy: { tools } } : {})
    UI.println(`Registered ${entry.id} (${fingerprintLabel(entry)}). Mask token: ⟦sec:${entry.id}⟧`)
  },
})

export const SecretsRotateCommand = cmd({
  command: "rotate <id>",
  describe: "replace a secret's value; policy and history carry over",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(argv) {
    const value = await prompts.password({ message: "New secret value" })
    if (prompts.isCancel(value) || !value) throw new UI.CancelledError()
    try {
      const entry = await SecretVault.rotate(argv.id, value)
      UI.println(`Rotated to ${entry.id} (${fingerprintLabel(entry)}). New mask token: ⟦sec:${entry.id}⟧`)
    } catch (error) {
      if (!(error instanceof SecretVault.NotFoundError)) throw error
      UI.error(`Secret ${argv.id} does not exist.`)
      throw new UI.CancelledError()
    }
  },
})

export const SecretsRemoveCommand = cmd({
  command: "remove <id>",
  describe: "remove a secret; historical mask tokens stop resolving",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(argv) {
    const confirmed = await prompts.confirm({
      message: `Remove ${argv.id}? Historical ⟦sec:${argv.id}⟧ tokens will no longer resolve.`,
    })
    if (prompts.isCancel(confirmed) || !confirmed) throw new UI.CancelledError()
    await SecretVault.remove(argv.id)
    UI.println(`Removed ${argv.id}.`)
  },
})

export const SecretsRevealCommand = cmd({
  command: "reveal <id>",
  describe: "print a secret's plaintext to this terminal (local process only; never over HTTP)",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(argv) {
    const value = await SecretVault.reveal(argv.id)
    if (value === undefined) {
      UI.error(`Secret ${argv.id} does not exist.`)
      throw new UI.CancelledError()
    }
    UI.println(value)
  },
})

export const SecretsCommand = cmd({
  command: "secrets <command>",
  describe: "manage the secret vault",
  builder: (yargs) =>
    yargs
      .command(SecretsListCommand)
      .command(SecretsRegisterCommand)
      .command(SecretsRotateCommand)
      .command(SecretsRemoveCommand)
      .command(SecretsRevealCommand)
      .demandCommand(1),
  async handler() {},
})
