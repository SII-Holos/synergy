import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
const [repo, home] = process.argv.slice(2)
if (
  !repo ||
  !home ||
  !path.resolve(home).startsWith(path.resolve(tmpdir()) + path.sep) ||
  (await Bun.file(path.join(home, "manifest.json")).exists())
)
  throw Error("isolated fixture required")
const workspace = path.join(home, "workspace")
await mkdir(workspace, { recursive: true })
process.env.SYNERGY_HOME = home
process.env.SYNERGY_CWD = workspace
process.env.SYNERGY_CONFIG_CONTENT = "{}"
process.env.MODELS_DEV_API_JSON = path.join(repo, "packages/testing/fixtures/models-api.json")
process.env.SYNERGY_DISABLE_MODELS_FETCH = "true"
process.env.SYNERGY_DISABLE_DEFAULT_PLUGINS = "true"
process.env.SYNERGY_DISABLE_FILEWATCHER = "true"
process.env.SYNERGY_DISABLE_LSP_DOWNLOAD = "1"
process.env.SYNERGY_DISABLE_BUILTIN_MCP = "1"
const load = async (file) => import(path.join(repo, file)),
  { PresetRuntimeHandle } = await load("packages/presets/src/server/runtime-handle.ts"),
  { createLocalHost } = await load("packages/local-runtime/src/host.ts"),
  { Scope } = await load("packages/harness/src/scope/index.ts"),
  { ScopeContext } = await load("packages/harness/src/scope/context.ts"),
  { Session } = await load("packages/harness/src/session/index.ts"),
  { MessageV2 } = await load("packages/harness/src/session/message-v2.ts"),
  saveMessage = async (info) =>
    Session.updateMessage(
      MessageV2.deriveSemantics([
        {
          info,
          parts:
            info.role === "user"
              ? [
                  {
                    id: "prt_semantics",
                    sessionID: info.sessionID,
                    messageID: info.id,
                    type: "text",
                    text: "Inspect the fixture.",
                  },
                ]
              : [],
        },
      ])[0].info,
    ),
  { SessionManager } = await load("packages/harness/src/session/manager.ts"),
  { ExecutionService } = await load("packages/workbench/src/execution/service.ts"),
  { NoteStore } = await load("packages/note/src/store.ts"),
  runtime = await PresetRuntimeHandle.open({
    host: createLocalHost({ home }),
    mode: "server",
    network: { hostname: "127.0.0.1", port: 0 },
    webAppDirectory: path.join(repo, "apps/web/dist"),
    environment: false,
  }),
  sessions = [],
  streams = [],
  time = 1802311200000
await runtime.run(async () => {
  const scopes = []
  for (let i = 0; i < 3; i++) {
    const directory = path.join(workspace, `scope-${i}`)
    await mkdir(directory, { recursive: true })
    await Bun.write(
      path.join(directory, "README.md"),
      `# Performance fixture

` +
        `Large file paragraph.

`.repeat(500),
    )
    scopes.push(await Scope.resolve({ directory }))
  }
  for (let i = 0; i < 12; i++) {
    const scope = scopes[i % 3]
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({
          id: `ses_fixture_${String(i).padStart(3, "0")}`,
          title: `Performance session ${i}`,
        })
        const messageCount = i === 0 ? 550 : 46
        for (let j = 0; j < messageCount; j++) {
          const id = `msg_fixture_${String(i).padStart(3, "0")}_${String(j).padStart(4, "0")}`,
            rootID = `msg_fixture_${String(i).padStart(3, "0")}_${String(j - (j % 2)).padStart(4, "0")}`
          await saveMessage(
            j % 2 === 0
              ? {
                  id,
                  sessionID: session.id,
                  role: "user",
                  agent: "general",
                  model: { providerID: "openai", modelID: "gpt-4o" },
                  time: { created: time + j * 1000 },
                }
              : {
                  id,
                  sessionID: session.id,
                  parentID: rootID,
                  rootID,
                  role: "assistant",
                  agent: "general",
                  mode: "general",
                  modelID: "gpt-4o",
                  providerID: "openai",
                  time: { created: time + j * 1000, completed: time + j * 1000 + 500 },
                  path: { cwd: directoryOf(scope), root: directoryOf(scope) },
                  cost: 0,
                  tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
                  finish: "stop",
                },
          )
          await Session.updatePart({
            id: `prt_fixture_${String(i).padStart(3, "0")}_${String(j).padStart(4, "0")}`,
            messageID: id,
            sessionID: session.id,
            type: "text",
            text:
              `Fixture ${i} message ${j}

` +
              (j % 2
                ? `## Section

Readable Markdown **bold** and \`code\`.

`.repeat(j === messageCount - 1 ? 150 : 5)
                : "Inspect the fixture."),
          })
          if (i === 0 && j === messageCount - 1)
            for (let k = 0; k < 2001; k++)
              await Session.updatePart({
                id: `prt_tool_${String(k).padStart(5, "0")}`,
                messageID: id,
                sessionID: session.id,
                type: "tool",
                callID: `call-${k}`,
                tool: "read",
                state: {
                  status: "completed",
                  input: { filePath: "README.md" },
                  output: "Repeated context. ".repeat(100),
                  title: `Read ${k}`,
                  metadata: {},
                  time: { start: time + k, end: time + k + 1 },
                },
              })
        }
        await Session.flushPartWrites(session.id)
        const note = await NoteStore.create(
          {
            title: `Fixture note ${i}`,
            content: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Retained note draft." }] }],
            },
          },
          { scopeID: scope.id },
        )
        sessions.push({
          id: session.id,
          scopeID: scope.id,
          title: session.title,
          noteID: note.id,
          route: `/${Buffer.from(scope.id).toString("base64url")}/session/${session.id}`,
        })
        if (i < 2) {
          const rootID = `msg_fixture_${String(i).padStart(3, "0")}_${String(messageCount).padStart(4, "0")}`
          await saveMessage({
            id: rootID,
            sessionID: session.id,
            role: "user",
            agent: "general",
            model: { providerID: "openai", modelID: "gpt-4o" },
            time: { created: time + messageCount * 1000 },
          })
          await Session.updatePart({
            id: `prt_stream_prompt_${i}`,
            messageID: rootID,
            sessionID: session.id,
            type: "text",
            text: "Continue streaming fixture.",
          })
          const message = {
            id: `msg_fixture_${String(i).padStart(3, "0")}_${String(messageCount + 1).padStart(4, "0")}`,
            parentID: rootID,
            rootID,
            sessionID: session.id,
            role: "assistant",
            agent: "general",
            mode: "general",
            modelID: "gpt-4o",
            providerID: "openai",
            time: { created: time + (messageCount + 1) * 1000 },
            path: { cwd: directoryOf(scope), root: directoryOf(scope) },
            cost: 0,
            tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          await saveMessage(message)
          const part = {
            id: `prt_stream_${i}`,
            messageID: message.id,
            sessionID: session.id,
            type: "text",
            text: "Streaming fixture: ",
          }
          await Session.updatePart(part)
          streams.push({ scope, message, part })
          await Session.create({ parentID: session.id, title: `Fixture child ${i}` })
          await ExecutionService.summary(session.id)
        }
      },
    })
  }
})
function directoryOf(scope) {
  return scope.directory ?? workspace
}
await Bun.write(
  path.join(home, "manifest.json"),
  JSON.stringify({ origin: runtime.server.url.toString().replace(/\/$/, ""), sessions }, null, 2),
)
console.log("FIXTURE_READY")
let burst
for await (const line of createInterface({ input: process.stdin })) {
  if (line === "burst")
    burst = runtime.run(async () => {
      await Promise.all(
        streams.map(async (item) =>
          ScopeContext.provide({
            scope: item.scope,
            fn: async () => {
              SessionManager.setStatus(item.message.sessionID, { type: "busy" })
              for (let k = 0; k < 300; k++) {
                const delta =
                  `chunk ${k}: ` +
                  "abcd ".repeat(50) +
                  `
`
                item.part = { ...item.part, text: item.part.text + delta }
                await Session.updatePartDelta(item.part, delta)
                if (k % 10 === 0)
                  await saveMessage({ ...item.message, tokens: { ...item.message.tokens, output: k * 50 } })
                await Bun.sleep(35)
              }
              await Session.updatePart(item.part)
              await saveMessage({
                ...item.message,
                time: { ...item.message.time, completed: Date.now() },
                finish: "stop",
                tokens: { ...item.message.tokens, output: 15000 },
              })
              await Session.flushPartWrites(item.message.sessionID)
              SessionManager.setStatus(item.message.sessionID, { type: "idle" })
            },
          }),
        ),
      )
      await Bun.write(path.join(home, "burst-done"), "done")
      console.log("BURST_DONE")
    })
  if (line === "stop") {
    await burst
    await runtime.close()
    break
  }
}
await runtime.close()
