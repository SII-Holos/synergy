import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

const scenarios: {
  name: string
  ownerID: string
  fields: Record<string, unknown>
  declared: boolean
  proof: "none" | "other" | "current"
  snapshot?: true
  message?: true
}[] = [
  ...(["none", "other", "current"] as const).map(
    (proof) =>
      ({
        name: `${proof === "current" ? "this member's" : proof === "other" ? "another member's" : "missing"} Environment proof`,
        ownerID: "session-environments",
        fields: { environmentID: "retained-environment" },
        declared: true,
        proof,
      }) as const,
  ),
  {
    name: "undeclared Environment",
    ownerID: "session-environments",
    fields: { environmentID: "retained-environment" },
    declared: false,
    proof: "none",
  },
  {
    name: "undeclared Cortex",
    ownerID: "cortex",
    fields: { cortex: { retained: true } },
    declared: false,
    proof: "none",
  },
  {
    name: "Cortex without its proof",
    ownerID: "cortex",
    fields: { cortex: { retained: true } },
    declared: true,
    proof: "none",
  },
  {
    name: "another member's Cortex proof",
    ownerID: "cortex",
    fields: { cortex: { retained: true } },
    declared: true,
    proof: "other",
  },
  {
    name: "this member's declared Cortex proof",
    ownerID: "cortex",
    fields: { cortex: { retained: true } },
    declared: true,
    proof: "current",
  },
  {
    name: "a projected-away future workflow",
    ownerID: "future-workflow",
    fields: { workflow: { kind: "extension", extension: { kind: "future-workflow" } } },
    declared: false,
    proof: "none",
  },
  {
    name: "undeclared Blueprint history",
    ownerID: "blueprint",
    fields: { blueprint: { retained: true } },
    declared: false,
    proof: "none",
  },
  {
    name: "undeclared SuperPlan history",
    ownerID: "blueprint",
    fields: { superplan: { retained: true } },
    declared: false,
    proof: "none",
  },
  {
    name: "undeclared Snapshot history",
    ownerID: "session-snapshots",
    fields: {},
    declared: false,
    proof: "none",
    snapshot: true,
  },
  {
    name: "undeclared message origin owner",
    ownerID: "channels",
    fields: {},
    declared: false,
    proof: "none",
    message: true,
  },
]

for (const scenario of scenarios)
  test(`raw target Core rejects ${scenario.name} until its current member has the required owner`, async () => {
    await using directory = await tmpdir()
    const store = {
      async put(hash: string, bytes: Uint8Array) {
        await Bun.write(path.join(directory.path, hash), bytes)
      },
      async get(hash: string, maximumBytes: number) {
        const file = Bun.file(path.join(directory.path, hash))
        if (file.size > maximumBytes) throw new Error("Oversized object")
        return new Uint8Array(await file.arrayBuffer())
      },
    }
    let ownerValidations = 0
    await using runtime = await testRuntime({
      register() {
        Core.register()
        Owners.register(scenario.ownerID, {
          version: 1,
          reads: [1],
          applies: () => false,
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
          async validate() {
            ownerValidations++
          },
          async publish() {},
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null, environmentID: null })
          const infoKey = ["sessions", "home", session.id, "info"]
          const base = await Storage.read<Record<string, unknown>>(infoKey)
          const fields =
            scenario.ownerID === "cortex"
              ? {
                  cortex: {
                    taskID: "fixture-task",
                    parentSessionID: "fixture-parent",
                    parentMessageID: "fixture-message",
                    description: "Retained task",
                    agent: "general",
                    startedAt: 1,
                    status: "completed",
                  },
                }
              : scenario.fields
          const raw = { ...base, ...fields }
          const projected = Session.Info.parse({ ...base, workspace: null })
          const hidden = Object.keys(scenario.fields)[0]
          if (hidden && hidden !== "environmentID") expect(projected).not.toHaveProperty(hidden)
          if (hidden === "environmentID") expect(projected.environmentID).toBeNull()
          const root = await Stream.write({
            store,
            owners: { "session-core": 1, ...(scenario.declared ? { [scenario.ownerID]: 1 } : {}) },
            entries: (async function* () {
              yield {
                id: "core",
                kind: "record" as const,
                metadata: { transferOwner: "session-core", transferSessionID: session.id, key: infoKey },
                content: (async function* () {
                  yield Buffer.from(JSON.stringify(raw))
                })(),
              }
              if (scenario.snapshot || scenario.message) {
                const messageID = "message-history"
                const partID = "part-history"
                const key = [
                  "sessions",
                  "home",
                  session.id,
                  "messages",
                  messageID,
                  ...(scenario.snapshot ? ["parts", partID] : ["info"]),
                ]
                yield {
                  id: "historical-requirement",
                  kind: "record" as const,
                  metadata: { transferOwner: "session-core", transferSessionID: session.id, key },
                  content: (async function* () {
                    yield Buffer.from(
                      JSON.stringify(
                        scenario.snapshot
                          ? { type: "snapshot", snapshot: "a".repeat(40) }
                          : {
                              id: messageID,
                              sessionID: session.id,
                              role: "user",
                              agent: "general",
                              model: { providerID: "fixture", modelID: "fixture" },
                              time: { created: 1 },
                              metadata: { requiredOwners: [scenario.ownerID] },
                            },
                      ),
                    )
                  })(),
                }
              }
              if (scenario.proof !== "none")
                yield {
                  id: "owner-proof",
                  kind: "record" as const,
                  metadata: {
                    transferOwner: scenario.ownerID,
                    transferSessionID: scenario.proof === "current" ? session.id : "other-member",
                    key: ["proof", scenario.ownerID],
                  },
                  content: (async function* () {
                    yield Buffer.from(JSON.stringify({ version: 1 }))
                  })(),
                }
              if (scenario.proof === "current")
                for (let index = 0; index < 20; index++)
                  yield {
                    id: `repeated-owner-${index}`,
                    kind: "record" as const,
                    metadata: {
                      transferOwner: "session-core",
                      transferSessionID: session.id,
                      key: ["sessions", "home", session.id, "messages", `repeated-${index}`, "info"],
                    },
                    content: (async function* () {
                      yield Buffer.from(
                        JSON.stringify({
                          id: `repeated-${index}`,
                          sessionID: session.id,
                          role: "user",
                          agent: "general",
                          model: { providerID: "fixture", modelID: "fixture" },
                          time: { created: index },
                          metadata: { requiredOwners: [scenario.ownerID] },
                        }),
                      )
                    })(),
                  }
            })(),
          })
          await Staging.receive({ handoffID: "required-raw-owner", root, store })
          const context = await Staging.context({
            ownerID: "session-core",
            handoffID: "required-raw-owner",
            session: projected,
            rootSessionID: session.id,
            mapping: {},
            signal: new AbortController().signal,
          })
          if (!context.staged.ownerVersion) throw new Error("Staged owner metadata port is unavailable")
          let metadataReads = 0
          const read = Storage.readMany
          const observed = spyOn(Storage, "readMany").mockImplementation(
            async <T>(keys: Parameters<typeof Storage.readMany>[0]) => {
              metadataReads += keys.filter((key) => key.at(-2) === scenario.ownerID && key.at(-1) === session.id).length
              return read<T>(keys)
            },
          )
          try {
            if (scenario.proof === "current") {
              await expect(Owners.validate("session-core", context)).resolves.toBeUndefined()
              expect(metadataReads).toBe(1)
            } else await expect(Owners.validate("session-core", context)).rejects.toThrow("required owner")
            expect(ownerValidations).toBe(0)
          } finally {
            observed.mockRestore()
          }
        },
      }),
    )
  })
