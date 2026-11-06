import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionNav } from "@ericsanchezok/synergy-harness/session/nav"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { NoteMarkdown, NoteStore } from "@ericsanchezok/synergy-note"
import { registerNote } from "@ericsanchezok/synergy-note/register"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { server } from "@ericsanchezok/synergy-server/component"
import { blueprint } from "../../src/component"
import { BlueprintLoopSources } from "../../src/blueprint/source"
import { migrations as loopMigrations } from "../../src/blueprint/migration"
import { migrations as sessionMigrations } from "../../src/session-migration"
import { bindingSourceMigration, bindingSourceAccessMigration } from "../../src/binding-source-migration"

const startupID = "20261012-blueprint-binding-sources"
const sessionID = "20261012-blueprint-control-sources"
const receipt = (id: string) => ["sessions", "home", id, "migrations", "blueprint-session", sessionID]
const inHome = <T>(fn: () => Promise<T>) => ScopeContext.provide({ scope: Scope.home(), fn })
const open = (home: string, sources: string[] = []) =>
  testRuntime({
    home,
    composition: {
      register() {
        registerLocalRuntime()
        registerNote()
        blueprint().register()
        server().register()
        for (const source of sources) BlueprintLoopSources.register(source)
      },
    },
  })

async function seed(source?: string) {
  const session = await Session.create({ title: "Retained source session" })
  const noteID = Identifier.ascending("note")
  const loopID = Identifier.ascending("blueprint_loop")
  const note = {
    id: noteID,
    kind: "blueprint",
    title: "Retained plan",
    content: NoteMarkdown.fromMarkdown("# Plan"),
    pinned: false,
    global: true,
    archived: false,
    tags: [],
    version: 1,
    time: { created: 10, updated: 10 },
    blueprint: {
      description: "Keep authoring",
      activeLoopID: loopID,
      lastRunAt: 20,
      runCount: 3,
      future: { keep: true },
    },
  }
  const loop = {
    id: loopID,
    noteID,
    title: note.title,
    sessionID: session.id,
    scopeID: "home",
    source,
    status: "running",
    auditAgent: "supervisor",
    time: { created: 20, updated: 20 },
    future: { keep: true },
  }
  const infoKey = ["sessions", "home", session.id, "info"]
  await Storage.write(["notes", "home", noteID], note)
  await Storage.write(["blueprint_loops", "home", loopID], loop)
  await Storage.write(infoKey, {
    ...(await Storage.read<Record<string, unknown>>(infoKey)),
    blueprint: { loopID, loopRole: "execution", phase: "running", future: { keep: true } },
  })
  await Storage.remove(receipt(session.id))
  await Storage.remove([
    "sessions",
    "home",
    session.id,
    "migrations",
    "blueprint-session",
    bindingSourceAccessMigration.id,
  ])
  return { session, note, loop, infoKey }
}

test("old loop evidence fills source bindings once and uninstall/reinstall projects cached navigation and Note reads", async () => {
  await using home = await tmpdir()
  let data!: Awaited<ReturnType<typeof seed>>
  await using absent = await testRuntime({ home: home.path, composition: { register: registerNote } })
  await absent.run(() =>
    inHome(async () => {
      data = await seed("lattice")
      await Storage.write(
        ["meta", "migration", "log-blueprint_loop"],
        Object.fromEntries(loopMigrations.map((m) => [m.id, 42])),
      )
      await Storage.write(
        ["meta", "migration", "log-blueprint-session"],
        Object.fromEntries(
          sessionMigrations.filter((m) => m.id !== startupID && m.id !== sessionID).map((m) => [m.id, 42]),
        ),
      )
    }),
  )
  await absent.close()
  let retainedNote: unknown
  let retainedBinding: unknown
  for (const sources of [["lattice"], [], ["lattice"]]) {
    await using runtime = await open(home.path, sources)
    await runtime.run(() =>
      inHome(async () => {
        const stored = await Storage.read<Record<string, unknown>>(data.infoKey)
        expect(stored.blueprint).toEqual({
          loopID: data.loop.id,
          loopRole: "execution",
          phase: "running",
          source: "lattice",
          future: { keep: true },
        })
        const note = await NoteStore.get("home", data.note.id)
        const info = Session.publicInfo(await Session.get(data.session.id))
        const nav = (await SessionNav.readNavIndex("home")).entries.find((entry) => entry.id === data.session.id)
        expect(note.blueprint?.description).toBe("Keep authoring")
        if (sources.length) {
          expect(note.blueprint?.activeLoopID).toBe(data.loop.id)
          expect(note.blueprint?.lastRunSource).toBe("lattice")
          expect(info.blueprint?.source).toBe("lattice")
          expect(nav?.blueprint?.loopID).toBe(data.loop.id)
        } else {
          expect(note.blueprint).toEqual({ description: "Keep authoring" })
          expect(info.blueprint).toBeUndefined()
          expect(nav?.blueprint).toBeUndefined()
          const before = await Storage.read<{ blueprint: unknown }>(["notes", "home", data.note.id])
          await NoteStore.update("home", data.note.id, { title: "Edited while source is absent" })
          const edited = await Storage.read<{ blueprint: unknown }>(["notes", "home", data.note.id])
          expect(edited.blueprint).toEqual(before.blueprint)
          retainedNote = edited
        }
        const raw = await Storage.read(["notes", "home", data.note.id])
        retainedNote ??= raw
        retainedBinding ??= stored.blueprint
        expect(raw).toEqual(retainedNote)
        expect(stored.blueprint).toEqual(retainedBinding)
        expect(
          (await Storage.read<Record<string, number>>(["meta", "migration", "log-blueprint-session"]))[startupID],
        ).toBeGreaterThan(0)
      }),
    )
  }
})

async function seedMessages(source: string = "lattice") {
  const data = await seed(source)
  const id = Identifier.ascending("message")
  const message: MessageV2.User = {
    id,
    sessionID: data.session.id,
    role: "user",
    agent: "atlas",
    model: { providerID: "test", modelID: "test" },
    time: { created: 30 },
    metadata: { source: "blueprint_loop_start", loopID: data.loop.id, future: { keep: true } },
  }
  const part: MessageV2.ToolPart = {
    id: Identifier.ascending("part"),
    sessionID: data.session.id,
    messageID: id,
    type: "tool",
    tool: "blueprint_loop_stop",
    callID: "retained-call",
    state: {
      status: "completed",
      input: {},
      title: "Stopped",
      output: JSON.stringify({ loop: { id: data.loop.id } }),
      metadata: { loopStopRequested: true, future: { keep: true } },
      time: { start: 30, end: 31 },
    },
  }
  const messageKey = ["sessions", "home", data.session.id, "messages", id, "info"]
  const partKey = ["sessions", "home", data.session.id, "messages", id, "parts", part.id]
  const displayMessageKey = ["sessions", "home", data.session.id, "display_message", id]
  const displayPartKey = ["sessions", "home", data.session.id, "display_part", id, part.id]
  const inboxKey = ["sessions", "home", data.session.id, "inbox", "inb_retained"]
  await Storage.write(messageKey, message)
  await Storage.write(partKey, part)
  await Storage.write(displayMessageKey, { ...SessionHistory.summarizeMessage(message), future: { keep: true } })
  await Storage.write(displayPartKey, { ...MessageV2.summarizePart(part), future: { keep: true } })
  await Storage.write(inboxKey, { message: { role: "user", metadata: message.metadata }, future: { keep: true } })
  const unrelatedKey = ["sessions", "home", data.session.id, "messages", Identifier.ascending("message"), "info"]
  await Storage.write(unrelatedKey, {
    ...message,
    id: unrelatedKey[4],
    metadata: { source: "user", loopID: data.loop.id },
  })
  return { ...data, message, part, messageKey, partKey, displayMessageKey, displayPartKey, inboxKey, unrelatedKey }
}

test("a direct HTTP message read migrates confirmed control messages, tool results, inbox and existing display versions", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seedMessages("plugin")
      const original = await Storage.read<Record<string, unknown>>(data.unrelatedKey)
      const response = await Server.App().request(`/session/${data.session.id}/message?scopeID=home`)
      expect(response.status).toBe(200)
      const messages = (await response.json()) as MessageV2.WithParts[]
      const migrated = messages.find((item) => item.info.id === data.message.id)!
      const features = ["blueprint", "plugin-host", "plugin-blueprint"]
      const owners = ["blueprint", "plugin-blueprint"]
      expect(migrated.info.metadata).toMatchObject({
        requiredFeatures: features,
        requiredOwners: owners,
        future: { keep: true },
      })
      expect((migrated.parts[0] as MessageV2.ToolPart).state.metadata).toMatchObject({ requiredFeatures: features })
      expect((migrated.parts[0] as MessageV2.ToolPart).state).toHaveProperty(
        "output",
        data.part.state.status === "completed" && data.part.state.output,
      )
      const displayed = await Storage.read<{ info: MessageV2.Info; future: unknown }>(data.displayMessageKey)
      expect(displayed.info.metadata?.requiredFeatures).toEqual(features)
      expect(displayed.future).toEqual({ keep: true })
      const displayedPart = await Storage.read<MessageV2.PartSummary & { future: unknown }>(data.displayPartKey)
      expect(displayedPart.content.version).not.toBe(MessageV2.summarizePart(data.part).content.version)
      expect(displayedPart.future).toEqual({ keep: true })
      expect(await Storage.read(data.inboxKey)).toMatchObject({
        message: { metadata: { requiredOwners: owners } },
        future: { keep: true },
      })
      expect(await Storage.read<Record<string, unknown>>(data.unrelatedKey)).toEqual(original)
      expect(await Storage.read(receipt(data.session.id))).toHaveProperty("completed")
      expect(Session.publicInfo(await Session.get(data.session.id)).blueprint).toBeUndefined()
    }),
  )
})

test("a first display manifest read migrates source controls before comparing cached display versions", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seedMessages("plugin")
      const cached = await Storage.read<{ version: string }>(data.displayMessageKey)
      const generation = 9
      await Storage.write(["sessions", "home", data.session.id, "display_parts_state", data.message.id], {
        version: 1,
        ready: true,
        generation,
      })
      expect((await Storage.read<MessageV2.User>(data.messageKey)).metadata?.requiredFeatures).toBeUndefined()

      const manifest = await SessionHistory.displayManifest({
        sessionID: data.session.id,
        messages: [{ messageID: data.message.id, version: cached.version, generation }],
      })
      expect(manifest.messages[0].status).toBe("changed")
      expect(manifest.messages[0].version).not.toBe(cached.version)
      const features = ["blueprint", "plugin-host", "plugin-blueprint"]
      const displayed = await Storage.read<{ info: MessageV2.Info; future: unknown }>(data.displayMessageKey)
      expect(displayed.info.metadata?.requiredFeatures).toEqual(features)
      expect(displayed.future).toEqual({ keep: true })
      const displayedPart = await Storage.read<MessageV2.PartSummary & { future: unknown }>(data.displayPartKey)
      expect(displayedPart.content.version).not.toBe(MessageV2.summarizePart(data.part).content.version)
      expect(displayedPart.future).toEqual({ keep: true })
      expect((await Storage.read<MessageV2.User>(data.messageKey)).metadata?.requiredFeatures).toEqual(features)
      expect((await Storage.read<Record<string, unknown>>(data.infoKey)).blueprint).toMatchObject({ source: "plugin" })
      expect(await Storage.read(receipt(data.session.id))).toHaveProperty("completed")
      expect(
        (
          await SessionHistory.displayManifest({
            sessionID: data.session.id,
            messages: manifest.messages,
          })
        ).messages[0].status,
      ).toBe("unchanged")
    }),
  )
})

test("a display manifest detects source requirements added only to a cached tool result", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seedMessages()
      const message: MessageV2.Assistant = {
        id: data.message.id,
        sessionID: data.session.id,
        role: "assistant",
        parentID: Identifier.ascending("message"),
        time: { created: 30, completed: 31 },
        modelID: "test",
        providerID: "test",
        path: { cwd: null, root: null },
        mode: "synergy",
        agent: "atlas",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        metadata: { future: { keep: true } },
      }
      const cached = { ...SessionHistory.summarizeMessage(message), future: { keep: true } }
      await Storage.write(data.messageKey, message)
      await Storage.write(data.displayMessageKey, cached)
      const stateKey = ["sessions", "home", data.session.id, "display_parts_state", message.id]
      const generation = 12
      await Storage.write(stateKey, { version: 1, ready: true, generation, future: { keep: true } })

      const manifest = await SessionHistory.displayManifest({
        sessionID: data.session.id,
        messages: [{ messageID: message.id, version: cached.version, generation }],
      })
      expect(manifest.messages[0]).toEqual({
        messageID: message.id,
        status: "changed",
        version: cached.version,
        generation: generation + 1,
      })
      expect(await Storage.read<MessageV2.Assistant>(data.messageKey)).toEqual(message)
      expect(await Storage.read<typeof cached>(data.displayMessageKey)).toEqual(cached)
      const part = await Storage.read<MessageV2.ToolPart>(data.partKey)
      expect(part.state.metadata).toMatchObject({ requiredFeatures: ["blueprint", "lattice"], future: { keep: true } })
      const displayed = await Storage.read<MessageV2.PartSummary & { future: unknown }>(data.displayPartKey)
      expect(displayed.content.version).toBe(MessageV2.summarizePart(part).content.version)
      expect(displayed.content.version).not.toBe(MessageV2.summarizePart(data.part).content.version)
      expect(displayed.future).toEqual({ keep: true })
      expect(await Storage.read<Record<string, unknown>>(stateKey)).toEqual({
        version: 1,
        ready: true,
        generation: generation + 1,
        future: { keep: true },
      })
      expect(
        (await SessionHistory.displayManifest({ sessionID: data.session.id, messages: manifest.messages })).messages[0]
          .status,
      ).toBe("unchanged")
      expect((await Storage.read<{ generation: number }>(stateKey)).generation).toBe(generation + 1)
    }),
  )
})

test("a missing central receipt retries an already committed control projection idempotently", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seedMessages()
      const keys = [
        data.infoKey,
        data.messageKey,
        data.partKey,
        data.displayMessageKey,
        data.displayPartKey,
        data.inboxKey,
      ]
      const before = await Storage.readMany(keys)
      const write = Storage.write
      const fail = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        if (key.join("/") === receipt(data.session.id).join("/")) throw new Error("receipt interrupted")
        return write(key, value)
      })
      try {
        await expect(Session.messages({ sessionID: data.session.id })).rejects.toThrow("receipt interrupted")
      } finally {
        fail.mockRestore()
      }
      const committed = await Storage.readMany(keys)
      expect(committed).not.toEqual(before)
      expect((committed[1] as MessageV2.User).metadata?.requiredFeatures).toEqual(["blueprint", "lattice"])
      expect((await Storage.readMany([receipt(data.session.id)]))[0]).toBeUndefined()
      await Session.messages({ sessionID: data.session.id })
      const once = await Storage.readMany(keys)
      expect(once).toEqual(committed)
      await Session.messages({ sessionID: data.session.id })
      expect(await Storage.readMany(keys)).toEqual(once)
    }),
  )
})

test("legacy user loops require real associated records and orphan bindings stay hidden", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seed()
      const orphan = await Session.create({ title: "Orphan binding" })
      const key = ["sessions", "home", orphan.id, "info"]
      const binding = { loopID: "bll_missing", loopRole: "execution", phase: "running", future: true }
      await Storage.write(key, { ...(await Storage.read<Record<string, unknown>>(key)), blueprint: binding })
      await Storage.remove(receipt(orphan.id))
      await Storage.remove([
        "sessions",
        "home",
        orphan.id,
        "migrations",
        "blueprint-session",
        bindingSourceAccessMigration.id,
      ])
      expect(Session.publicInfo(await Session.get(data.session.id)).blueprint?.source).toBe("user")
      expect(Session.publicInfo(await Session.get(orphan.id)).blueprint).toBeUndefined()
      expect((await Storage.read<Record<string, unknown>>(key)).blueprint).toEqual(binding)
    }),
  )
})

test("an interrupted startup catchup retries without changing unknown fields or replaying lifecycle writes", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seed("lattice")
      await Storage.write(["notes", "home", "_index"], [{ stale: true }])
      await expect(
        bindingSourceMigration.up(() => {
          throw new Error("startup interrupted")
        }),
      ).rejects.toThrow("startup interrupted")
      const keys = [data.infoKey, ["notes", "home", data.note.id], ["blueprint_loops", "home", data.loop.id]]
      const once = await Storage.readMany<Record<string, unknown>>(keys)
      expect(once[1]).toMatchObject({
        version: 1,
        blueprint: { activeLoopSource: "lattice", lastRunSource: "lattice", future: { keep: true } },
      })
      expect((await Storage.readMany([["notes", "home", "_index"]]))[0]).toBeUndefined()
      await bindingSourceMigration.up(() => {})
      expect(await Storage.readMany<Record<string, unknown>>(keys)).toEqual(once)
      expect(once[2]).toEqual(data.loop)
    }),
  )
})

test("a control record naming another Session's loop is not sufficient source evidence", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seedMessages()
      const other = await Session.create({ title: "Unrelated session" })
      const message = { ...data.message, sessionID: other.id }
      const key = ["sessions", "home", other.id, "messages", message.id, "info"]
      await Storage.write(key, message)
      await Storage.remove(receipt(other.id))
      const response = await Server.App().request(`/session/${other.id}/message/${message.id}?scopeID=home`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as MessageV2.WithParts).info.metadata).toEqual(message.metadata)
      expect(await Storage.read<MessageV2.User>(key)).toEqual(message)
      expect((await Storage.read<MessageV2.User>(data.messageKey)).metadata?.requiredFeatures).toBeUndefined()
    }),
  )
})

test("sidebar metadata admission derives bindings without reading control history", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seedMessages()
      const queries: string[] = []
      const records = Storage.records
      const observed = spyOn(Storage, "records").mockImplementation((input) => {
        if (["message", "part", "inbox"].includes(input?.kind ?? "")) queries.push(input!.kind!)
        return records(input)
      })
      try {
        await SessionNav.buildNavIndex("home")
      } finally {
        observed.mockRestore()
      }
      expect(queries).toEqual([])
      expect((await Storage.read<MessageV2.User>(data.messageKey)).metadata?.requiredFeatures).toBeUndefined()
      expect((await Storage.read<Record<string, unknown>>(data.infoKey)).blueprint).toMatchObject({ source: "lattice" })
    }),
  )
})

test("a failed derived control write rolls back its canonical message and part updates", async () => {
  await using home = await tmpdir()
  await using runtime = await open(home.path)
  await runtime.run(() =>
    inHome(async () => {
      const data = await seedMessages()
      const keys = [data.messageKey, data.partKey, data.displayMessageKey, data.displayPartKey, data.inboxKey]
      const before = await Storage.readMany(keys)
      const write = Storage.write
      const fail = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        if (key.join("/") === data.displayPartKey.join("/")) throw new Error("derived write interrupted")
        return write(key, value)
      })
      try {
        await expect(MessageV2.get({ sessionID: data.session.id, messageID: data.message.id })).rejects.toThrow(
          "derived write interrupted",
        )
      } finally {
        fail.mockRestore()
      }
      expect(await Storage.readMany(keys)).toEqual(before)
      expect((await Storage.readMany([receipt(data.session.id)]))[0]).toBeUndefined()
      const message = await MessageV2.get({ sessionID: data.session.id, messageID: data.message.id })
      expect(message.info.metadata?.requiredFeatures).toEqual(["blueprint", "lattice"])
    }),
  )
})
