import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { InstalledInput, InstalledResult } from "./installed-protocol"

async function main() {
  const input = InstalledInput.parse(await Bun.file(process.argv[2]!).json())
  const artifact = await fs.realpath(input.artifact)
  const resolved: Record<string, string> = {}
  for (const name of [
    "@ericsanchezok/synergy-local-runtime",
    "@ericsanchezok/synergy-agent-runtime",
    "@ericsanchezok/synergy-harness/session",
    "@ericsanchezok/synergy-plugin-host/installation/generations",
    ...(input.profile === "full" ? ["@ericsanchezok/synergy-presets"] : []),
    ...(input.mode === "sdk" ? ["@ericsanchezok/synergy-sdk/client"] : []),
  ]) {
    const file = await fs.realpath(fileURLToPath(import.meta.resolve(name)))
    if (!file.startsWith(artifact + path.sep)) throw new Error("Public entry resolved outside the frozen installation")
    resolved[name] = path.relative(artifact, file)
  }
  const { InstallationGenerations } = await import("@ericsanchezok/synergy-plugin-host/installation/generations")
  const inventory = await InstallationGenerations.readSeed(artifact)
  const { createLocalHost } = await import("@ericsanchezok/synergy-local-runtime")
  const host = createLocalHost({ home: input.home })
  const { openAgentRuntime } = await import("@ericsanchezok/synergy-agent-runtime")
  let fixture: import("@ericsanchezok/synergy-agent-runtime").RuntimeComponent | undefined
  if (input.coordination) {
    const directory = input.coordination
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if (input.mode === "seed") {
      const { FileMutation } = await import("@ericsanchezok/synergy-local-runtime/file/mutation")
      if (!Reflect.set(FileMutation, "lockDirectory", async () => directory))
        throw new Error("Legacy lock directory cannot be isolated")
    } else {
      const { registerLocalRuntime } = await import("@ericsanchezok/synergy-local-runtime/register")
      const { WorkspaceCoordinator } = await import("@ericsanchezok/synergy-local-runtime/workspace/coordinator")
      fixture = {
        id: "acceptance-workspace",
        apiVersion: 1,
        version: "local",
        register() {
          registerLocalRuntime({ workers: false, workspaceCoordinator: new WorkspaceCoordinator({ directory }) })
        },
      }
    }
  }
  const runtime = fixture
    ? await openAgentRuntime({
        host,
        home: host.root,
        mode: "oneshot",
        listen: false,
        components: [...(await import("@ericsanchezok/synergy-presets")).fullComponents(), fixture],
      })
    : input.profile === "full"
      ? await (
          await import("@ericsanchezok/synergy-presets")
        ).PresetRuntimeHandle[input.mode === "sdk" ? "open" : "openTask"]({
          host,
          mode: "oneshot",
          network: { hostname: "127.0.0.1", port: 0 },
        })
      : await (
          await import("@ericsanchezok/synergy-agent-runtime")
        ).openAgentRuntime({ host, home: host.root, mode: "oneshot", listen: false })
  const { Scope } = await import("@ericsanchezok/synergy-harness/scope")
  const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
  const { Session } = await import("@ericsanchezok/synergy-harness/session")
  const { SessionInvoke } = await import("@ericsanchezok/synergy-harness/session/invoke")
  const { SessionInputStatus } = await import("@ericsanchezok/synergy-harness/session/input-status")
  const { createUserMessage } = await import("@ericsanchezok/synergy-harness/session/input")
  const { Asset } = await import("@ericsanchezok/synergy-harness/asset/asset")
  let result: InstalledResult | undefined
  try {
    result = await runtime.run(async () => {
      const scope = (await Scope.fromDirectory(input.workspace)).scope
      return ScopeContext.provide({
        scope,
        fn: async () => {
          let session = input.sessionID ? await Session.get(input.sessionID) : undefined
          const before = session ? await Session.messages({ sessionID: session.id }) : []
          let attachmentID = input.attachmentID
          if (input.attachment)
            attachmentID = await Asset.write(Buffer.from(input.attachment), "text/plain", "saved-record.txt")
          let messageID: string | undefined
          if (input.mode === "sdk") {
            if (!runtime.server) throw new Error("Installed HTTP transport is missing")
            const { createSynergyClient } = await import("@ericsanchezok/synergy-sdk/client")
            const client = createSynergyClient({
              baseUrl: `http://127.0.0.1:${runtime.server.port}`,
              scopeID: scope.id,
              directory: input.workspace,
            })
            const created = (
              await client.session.create(
                { title: "Installed SDK task", controlProfile: "full_access" },
                { throwOnError: true },
              )
            ).data
            if (!created) throw new Error("SDK did not return a session")
            session = await Session.get(created.id)
            const accepted = (
              await client.session.input(
                {
                  sessionID: session.id,
                  agent: input.agent,
                  model: input.model,
                  parts: [{ type: "text", text: input.prompt }],
                  tools: { "*": false, bash: true },
                },
                { throwOnError: true },
              )
            ).data!
            messageID = accepted.status === "started" ? accepted.messageID : accepted.item.messageID
            if (!messageID) throw new Error("SDK did not return the admitted input identity")
            const deadline = Date.now() + input.deadlineMs
            for (;;) {
              const state = (
                await client.session.inputStatus({ sessionID: session.id, messageID }, { throwOnError: true })
              ).data!
              if (["completed", "cancelled", "failed"].includes(state.state)) break
              if (Date.now() >= deadline) throw new Error("Installed SDK task exceeded its deadline")
              await Bun.sleep(50)
            }
            const messages = (await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data!
            await Bun.write(path.join(path.dirname(input.result), "sdk-messages.json"), JSON.stringify(messages))
          } else if (input.mode !== "inspect") {
            session ??= await Session.create({ title: "Installed embedding task", controlProfile: "full_access" })
            const message = await createUserMessage({
              sessionID: session.id,
              model: input.model,
              agent: input.agent,
              tools: { "*": false, bash: true },
              parts: [
                { type: "text", text: input.prompt },
                ...(input.mode === "seed" && attachmentID
                  ? [
                      {
                        type: "attachment" as const,
                        mime: "text/plain",
                        filename: "saved-record.txt",
                        url: `asset://${attachmentID}`,
                      },
                    ]
                  : []),
              ],
            })
            messageID = message.info.id
            await SessionInvoke.loop.force(session.id)
          }
          if (!session) throw new Error("Installed task has no persisted session")
          try {
            let state = messageID ? await SessionInputStatus.get({ sessionID: session.id, messageID }) : undefined
            const deadline = Date.now() + input.deadlineMs
            while (state && !["completed", "cancelled", "failed"].includes(state.state)) {
              if (Date.now() >= deadline) throw new Error("Installed task did not finish its durable recording")
              await Bun.sleep(50)
              state = await SessionInputStatus.get({ sessionID: session.id, messageID: state.messageID })
            }
            const messages = await Session.messages({ sessionID: session.id })
            const replies = messages.filter(
              (message) => message.info.role === "assistant" && (!messageID || message.info.parentID === messageID),
            )
            const answer = replies
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            let terminal: InstalledResult["terminal"]
            if (input.mode === "embedding") {
              const { Pty } = await import("@ericsanchezok/synergy-local-runtime/process/pty")
              const expected = `installed-terminal-你好-${crypto.randomUUID()}`
              const info = await Pty.create({
                sessionID: session.id,
                command: process.execPath,
                args: [
                  "-e",
                  `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(expected)}, () => process.exit(0)))`,
                ],
              })
              terminal = { pid: info.pid!, output: "", expected, closed: false }
              const observed = terminal
              try {
                Pty.connect(info.id, {
                  readyState: 1,
                  send(data) {
                    observed.output += data
                  },
                  close() {
                    observed.closed = true
                  },
                })
                Pty.write(info.id, "go\n")
                while (!observed.closed) {
                  if (Date.now() >= deadline) throw new Error("Installed terminal did not drain and close")
                  await Bun.sleep(10)
                }
              } finally {
                await Pty.remove(info.id)
              }
              if (!observed.output.endsWith(expected)) throw new Error("Installed terminal output was truncated")
            }
            const attachment = attachmentID ? await Asset.read(attachmentID) : undefined
            return InstalledResult.parse({
              sessionID: session.id,
              completed: state
                ? state.state === "completed"
                : replies.some(
                    (message) =>
                      message.info.role === "assistant" && !message.info.error && message.info.time.completed,
                  ),
              answer,
              messages,
              before,
              attachmentID,
              attachment: attachment ? await attachment.text() : null,
              components: runtime.components.map((component) => component.id),
              inventory: inventory.sha256,
              resolved,
              closed: false,
              terminal,
            })
          } finally {
            await SessionInvoke.cancel(session.id)
          }
        },
      })
    })
  } finally {
    await runtime.close()
  }
  await Bun.write(input.result, JSON.stringify({ ...result, closed: true }, null, 2), { mode: 0o600 })
}

if (import.meta.main) await main()
