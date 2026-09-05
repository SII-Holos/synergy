import fs from "fs/promises"
import path from "path"
import { Global } from "../../../src/global"
import { Scope } from "../../../src/scope"
import { ScopeContext } from "../../../src/scope/context"
import { Session } from "../../../src/session"
import { SessionInbox } from "../../../src/session/inbox"
import { SessionInvoke } from "../../../src/session/invoke"
import { MessageV2 } from "../../../src/session/message-v2"

// Must run with an explicit isolated SYNERGY_HOME (parent test sets it).
const home = process.env["SYNERGY_HOME"]
if (!home) throw new Error("SYNERGY_HOME must be set")
await fs.mkdir(home, { recursive: true })

// Seed the pinned models catalog cache so no network catalog fetch is
// attempted, and disable plugin/LSP/filewatcher activity.
await fs.mkdir(path.join(home, ".synergy", "cache"), { recursive: true })
await fs.writeFile(path.join(home, ".synergy", "cache", "version"), "15")
const modelsCachePath = path.join(home, ".synergy", "cache", "models.json")
const packageRoot = process.env["SYNERGY_PACKAGE_ROOT"] ?? process.cwd()
const modelsFixture = await Bun.file(path.join(packageRoot, "test/tool/fixtures/models-api.json")).text()
await fs.writeFile(modelsCachePath, modelsFixture)
process.env["MODELS_DEV_API_JSON"] = modelsCachePath
process.env["SYNERGY_DISABLE_MODELS_FETCH"] = "true"
process.env["SYNERGY_DISABLE_DEFAULT_PLUGINS"] = "true"
process.env["SYNERGY_DISABLE_LSP_DOWNLOAD"] = "true"
process.env["SYNERGY_DISABLE_FILEWATCHER"] = "true"
delete process.env["SYNERGY_TEST_HOME"]

const [phase, workdir, output] = process.argv.slice(2)
if (!phase || !workdir || !output) throw new Error("Expected phase, workdir, and output path")
await fs.mkdir(workdir, { recursive: true })
await fs.mkdir(path.join(workdir, ".synergy"), { recursive: true })
const sidPath = path.join(workdir, "sid.json")

const deliveryKey = "feishu:thread:restart-while-queued:once"
const text = "process B must recover this queued channel task after restart"
const metadata = {
  source: "channel",
  channelPush: true,
  channelReply: true,
  channelReplyToMessageId: "om_original_feishu_message",
  replyTo: "oc_thread_original_123",
}

function fail(message: string): never {
  throw new Error(message)
}

async function sessionIDFromDisk(): Promise<string> {
  const sid = await fs.readFile(sidPath, "utf8").catch(() => undefined)
  if (sid) return sid.trim()
  const entries = await fs.readdir(path.join(Global.Path.data, "session-index")).catch(() => [])
  const found = entries.find((entry) => entry.startsWith("ses_"))?.replace(/\.json$/, "")
  if (!found) fail("could not locate session from previous process")
  return found
}

if (phase === "enqueue") {
  const scope = (await Scope.fromDirectory(workdir)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const session = await Session.create({ scope, title: "restart-while-queued" })
      const sid = session.id

      const first = await SessionInbox.deliverUnique({
        sessionID: sid,
        deliveryKey,
        mode: "task",
        message: {
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text }],
          metadata,
        },
      })
      const duplicate = await SessionInbox.deliverUnique({
        sessionID: sid,
        deliveryKey,
        mode: "task",
        message: {
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text }],
          metadata,
        },
      })
      if (duplicate.created) fail("duplicate enqueue before restart did not dedupe")

      const items = await SessionInbox.list(sid)
      const stored = items[0] ?? fail("no inbox item after enqueue")
      const messages = await Session.messages({ sessionID: sid })

      await fs.writeFile(sidPath, sid)
      await fs.writeFile(
        output,
        JSON.stringify({
          sessionID: sid,
          scopeID: scope.id,
          itemID: first.itemID,
          messageID: first.messageID,
          queued: true,
          itemCount: items.length,
          itemDeliveryKey: stored.deliveryKey ?? null,
          itemMetadata: stored.message?.metadata ?? null,
          rootMessages: messages.filter((m) => m.info.role === "user" && (m.info as MessageV2.User).isRoot).length,
        }),
      )
    },
  })
  // Exits without draining the inbox: the queued task must survive in the
  // durable store for a fresh process to recover.
  process.exit(0)
}

if (phase === "recover") {
  // Fresh process over the same SYNERGY_HOME. No delivery trigger: only the
  // startup recovery seam may discover and drive the queued inbox item.
  const scope = (await Scope.fromDirectory(workdir)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await SessionInvoke.resumePending({ scopeID: scope.id, waitForProcessing: true })
      const sid = await sessionIDFromDisk()

      const items = await SessionInbox.list(sid)
      const messages = await Session.messages({ sessionID: sid })
      const rootMessages = messages.filter((m) => m.info.role === "user" && (m.info as MessageV2.User).isRoot)
      const materialized = rootMessages[0]
      const assistantMessages = messages.filter((m) => m.info.role === "assistant")
      const assistantErrorMessages = assistantMessages.filter(
        (message) =>
          message.info.role === "assistant" && (message.info.finish === "error" || message.info.error != null),
      )
      const materializedInfo = materialized?.info && materialized.info.role === "user" ? materialized.info : undefined
      const materializedMetadata = materializedInfo?.metadata

      await fs.writeFile(
        output,
        JSON.stringify({
          sessionID: sid,
          queuedItems: items.length,
          queuedDeliveryKeys: items.map((item) => item.deliveryKey ?? null),
          rootMessages: rootMessages.length,
          materializedMessageID: materialized?.info.id ?? null,
          materializedText: materialized
            ? materialized.parts
                .filter((part) => part.type === "text")
                .map((part) => (part as { text?: unknown }).text)
                .filter((text): text is string => typeof text === "string")
                .join(" ")
            : null,
          materializedInboxDeliveryKey: materializedMetadata?.inboxDeliveryKey ?? null,
          materializedChannelReplyTo: materializedMetadata?.channelReplyToMessageId ?? null,
          materializedReplyTo: materializedMetadata?.replyTo ?? null,
          assistantMessages: assistantMessages.length,
          assistantErrorMessages: assistantErrorMessages.length,
        }),
      )
    },
  })
  process.exit(0)
}

fail(`unknown phase: ${phase}`)
