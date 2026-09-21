import { StorageMaintenance } from "../../../src/storage/maintenance"
await using storageHandle = await StorageMaintenance.open({ migrate: false, recover: true })
import fs from "fs/promises"
import path from "path"
import { Scope } from "../../../src/scope"
import { ScopeContext } from "../../../src/scope/context"
import { Session } from "../../../src/session"
import { SessionInbox } from "../../../src/session/inbox"
import { SessionInvoke } from "../../../src/session/invoke"
import { SessionLifecycle } from "../../../src/session/lifecycle"
import { SessionRecovery } from "../../../src/session/recovery"
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
const modelsFixture = await Bun.file(
  new URL(import.meta.resolve("@ericsanchezok/synergy-testing/models-api.json")),
).text()
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
const enqueueReport = path.join(workdir, "enqueue.json")

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

      // A machine session carrying the same durable work. The pause latch
      // deliberately does not apply to it, so a restart must treat the two
      // sessions differently even though their queued state is identical.
      const machine = await Session.create({ scope, title: "restart-while-queued-unattended" })
      await Session.update(machine.id, (draft) => {
        draft.interaction = { mode: "unattended", source: "channel:test-channel" }
      })
      const machineDelivery = await SessionInbox.deliverUnique({
        sessionID: machine.id,
        deliveryKey: `${deliveryKey}:unattended`,
        mode: "task",
        message: {
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text }],
          metadata,
        },
      })

      const items = await SessionInbox.list(sid)
      const stored = items[0] ?? fail("no inbox item after enqueue")
      const messages = await Session.messages({ sessionID: sid })

      await fs.writeFile(
        output,
        JSON.stringify({
          sessionID: sid,
          unattendedSessionID: machine.id,
          scopeID: scope.id,
          itemID: first.itemID,
          messageID: first.messageID,
          unattendedItemID: machineDelivery.itemID,
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
  await storageHandle.close()
  process.exit(0)
}

if (phase === "recover") {
  // Fresh process over the same SYNERGY_HOME. No delivery trigger and no
  // explicit drive: only the real startup seam runs, which is exactly what a
  // restart executes.
  const scope = (await Scope.fromDirectory(workdir)).scope
  const seeded = JSON.parse(await fs.readFile(enqueueReport, "utf8")) as {
    sessionID: string
    unattendedSessionID: string
  }
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await SessionRecovery.reconcileRuntimeState({ scopeID: scope.id, apply: true })
      await SessionInvoke.reconcilePausedSessions(scope.id)

      const sid = seeded.sessionID
      const machineID = seeded.unattendedSessionID
      const items = await SessionInbox.list(sid)
      const stored = items[0]
      const messages = await Session.messages({ sessionID: sid })

      const interactive = await Session.get(sid)
      const machine = await Session.get(machineID)

      await fs.writeFile(
        output,
        JSON.stringify({
          sessionID: sid,
          unattendedSessionID: machineID,
          queuedItems: items.length,
          queuedDeliveryKeys: items.map((item) => item.deliveryKey ?? null),
          queuedMetadata: stored?.message?.metadata ?? null,
          rootMessages: messages.filter((m) => m.info.role === "user" && (m.info as MessageV2.User).isRoot).length,
          latchReason: (await SessionLifecycle.snapshot(sid))?.reason ?? null,
          unattendedLatchReason: (await SessionLifecycle.snapshot(machineID))?.reason ?? null,
          // The gate both registries read, so the contrast is the real
          // automatic-drive decision and not a detail of one code path.
          interactiveDriveBlocked: await SessionLifecycle.blocksDrive(interactive),
          unattendedDriveBlocked: await SessionLifecycle.blocksDrive(machine),
          unattendedQueuedItems: (await SessionInbox.list(machineID)).length,
        }),
      )
    },
  })
  await storageHandle.close()
  process.exit(0)
}

fail(`unknown phase: ${phase}`)
