import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutRecordKeys } from "../../src/session/rollout/record-keys"
import type { RolloutSchema } from "../../src/session/rollout/schema"
import { EnvironmentOriginSchema } from "../../src/environment/origin-schema"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"

const register = () => {
  Core.register()
  Owners.register("origin-reader", {
    version: 1,
    reads: [1],
    stagedDependencies: ["session-core"],
    applies: () => true,
    async inspect() {
      return {
        requirements: [],
        children: (async function* () {
          yield* []
        })(),
      }
    },
    async freeze() {},
    async *export(context) {
      yield {
        id: context.session.id,
        kind: "record",
        metadata: { key: ["origin-reader", context.session.id] },
        content: (async function* () {
          yield Buffer.from("{}")
        })(),
      }
    },
    async validate() {},
    async publish() {},
  })
}

test.each(["latest", "equal-input", "ambiguous", "missing", "wrong-root"] as const)(
  "staged Core verifies native Environment origins with canonical %s tool evidence",
  async (kind) => {
    const values = new Map<string, Uint8Array>()
    const store = {
      async put(hash: string, bytes: Uint8Array) {
        values.set(hash, bytes.slice())
      },
      async get(hash: string, maximum: number) {
        const bytes = values.get(hash)
        if (!bytes || bytes.length > maximum) throw new Error("Missing origin evidence fixture content")
        return bytes.slice()
      },
    }
    const signal = new AbortController().signal
    await using source = await testRuntime({ register })
    const captured = await source.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspaceID: null, environmentID: null })
          const rootID = Identifier.ascending("message")
          const otherRoot = Identifier.ascending("message")
          for (const id of [rootID, otherRoot])
            await Session.updateMessage({
              id,
              rootID: id,
              isRoot: true,
              role: "user",
              sessionID: session.id,
              agent: "general",
              model: { providerID: "fixture", modelID: "fixture" },
              time: { created: 1 },
            })
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "assistant",
            parentID: rootID,
            rootID,
            agent: "general",
            modelID: "fixture",
            providerID: "fixture",
            mode: "default",
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 2 },
          })
          const owner: RolloutSchema.Owner = { kind: "session", scopeID: "home", sessionID: session.id }
          await RolloutLedger.beginRun(owner, rootID)
          const input = await RolloutArtifact.writeText(owner, "original", "text/plain")
          const first: RolloutSchema.ToolExecutionRecord = {
            version: 1,
            id: crypto.randomUUID(),
            owner,
            runID: rootID,
            messageID,
            toolCallID: "native-call",
            tool: "bash",
            started: 100,
            status: "completed",
            input,
          }
          const second: RolloutSchema.ToolExecutionRecord = {
            ...first,
            id: crypto.randomUUID(),
            started: kind === "latest" ? 101 : 100,
            input: kind === "ambiguous" ? await RolloutArtifact.writeText(owner, "another", "text/plain") : input,
          }
          for (const tool of [first, second])
            await RolloutJournal.write(
              owner,
              RolloutRecordKeys.tool(RolloutArtifact.root(owner), rootID, tool.id),
              tool,
            )
          const origin = EnvironmentOriginSchema.Session.parse({
            kind: "session",
            scopeID: "home",
            sessionID: session.id,
            rootID: kind === "wrong-root" ? otherRoot : rootID,
            runID: rootID,
            messageID,
            callID: kind === "missing" ? "absent-call" : "native-call",
            tool: "bash",
          })
          const query = { runID: origin.runID, messageID, toolCallID: origin.callID, tool: origin.tool }
          if (kind === "ambiguous") await expect(RolloutLedger.toolForPart(owner, query)).rejects.toThrow("ambiguous")
          else if (kind === "missing") expect(await RolloutLedger.toolForPart(owner, query)).toBeUndefined()
          else
            expect((await RolloutLedger.toolForPart(owner, query))?.id).toBe(
              kind === "latest" ? second.id : [first.id, second.id].sort().at(-1),
            )
          const binding = {
            scopeID: "home",
            sessionID: session.id,
            handoffID: "native-origin-" + kind,
            sourceID: "A",
            targetID: "B",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const prepared = await Source.prepare({ binding, store, signal, async verify() {} })
          return { session: await Session.get(session.id), origin, binding, prepared }
        },
      }),
    )
    await using target = await testRuntime({ register })
    await target.run(async () => {
      await Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal })
      const context = await Staging.context({
        handoffID: captured.binding.handoffID,
        rootSessionID: captured.session.id,
        ownerID: "origin-reader",
        session: captured.session,
        signal,
        mapping: {},
      })
      let scans = 0
      const original = context.staged.relatedRecords
      if (!original) throw new Error("Core dependency is unavailable")
      const selected = {
        ...context,
        staged: {
          ...context.staged,
          relatedRecords(ownerID: string) {
            scans++
            return original(ownerID)
          },
        },
      }
      const outcome = Core.validateEnvironmentOrigins(
        selected,
        (async function* () {
          for (let index = 0; index < 129; index++) yield captured.origin
        })(),
      )
      if (kind === "latest" || kind === "equal-input") await outcome
      else
        await expect(outcome).rejects.toThrow(kind === "wrong-root" ? "canonical native root" : "missing or ambiguous")
      expect(scans).toBe(1)
    })
  },
  15_000,
)

test("cancelling a delayed portability discovery cannot pause its original native Session", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using runtime = await testRuntime({
    register() {
      Core.register()
      Owners.register("delayed-discovery", {
        version: 1,
        reads: [1],
        async applies() {
          entered.resolve()
          await release.promise
          return true
        },
        async inspect() {
          return {
            requirements: [],
            children: (async function* () {
              yield* []
            })(),
          }
        },
        async freeze() {},
        async *export() {
          yield* []
        },
        async validate() {},
        async publish() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const controller = new AbortController()
        const reason = new Error("Original portability discovery stopped")
        const preparing = Source.prepare({
          binding: {
            scopeID: "home",
            sessionID: session.id,
            handoffID: "cancel-discovery",
            sourceID: "A",
            targetID: "B",
            fromEpoch: 1,
            toEpoch: 2,
          },
          signal: controller.signal,
          async verify() {},
          store: {
            async put() {
              throw new Error("Cancelled discovery cannot write a package")
            },
            async get() {
              throw new Error("No package exists")
            },
          },
        })
        const outcome = preparing.then(
          () => undefined,
          (error: unknown) => error,
        )
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("Discovery ended before its native barrier")
          }),
        ])
        controller.abort(reason)
        release.resolve()
        expect(await outcome).toBe(reason)
        expect((await Session.get(session.id)).paused).toBeUndefined()
        expect(await Epochs.isFrozen(session.id)).toBe(false)
      },
    }),
  )
}, 15_000)
