import { expect, test } from "bun:test"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { OrganizationSharedHistory } from "../src/shared-history"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { sharedProducerFixture } from "./support/shared-producer"

type Fixture = Awaited<ReturnType<typeof sharedProducerFixture>>
async function historical(f: Fixture) {
  const rows = await f.run(() =>
    Storage.snapshot(async (tx) => {
      const rows = new Map<string, unknown>()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  const groups = new Map<string, string>()
  const accepted = new Set<string>()
  const source: OrganizationSharedHistory.Source = {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      const value = rows.get(JSON.stringify(key))
      if (value === undefined) throw new Error("Missing original reference owner")
      return schema.parse(structuredClone(value))
    },
    *entries(prefix) {
      for (const [key, value] of [...rows].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
        const parsed = z.array(z.string()).parse(JSON.parse(key))
        if (prefix.every((part, index) => parsed[index] === part)) yield { key: parsed, value: structuredClone(value) }
      }
    },
    accept(key) {
      accepted.add(JSON.stringify(key))
    },
    first(key, value) {
      const id = JSON.stringify(key),
        hash = digest(JSON.stringify(value)),
        previous = groups.get(id)
      if (previous !== undefined && previous !== hash) throw new Error("The original reference group changed")
      if (previous !== undefined) return false
      groups.set(id, hash)
      return true
    },
    async binary(key, maximum) {
      return f.run(() => Storage.readBinary(key, { maxBytes: maximum }))
    },
  }
  return { source, accepted }
}

for (const kind of ["available blob", "nested content", "tool input", "tool output", "tool error"] as const) {
  test(`historical sharing rejects an ACKed ${kind} without its original upload owner`, async () => {
    await using f = await sharedProducerFixture()
    const id = "missing-" + kind.replaceAll(" ", "-")
    await f.run(() =>
      Directory.reservePrivate(f.credentials.alice, {
        sessionID: id,
        projectID: "project",
        runtimeID: "runtime-alice",
      }),
    )
    const session = await f.run(() => Directory.get(f.credentials.alice, id))
    await f.run(() => Sharing.share(f.credentials.alice, id, { expectedShareGeneration: 0 }))
    const root = Sync.Event.parse({
      type: "session",
      sequence: 1,
      session: {
        sessionID: id,
        projectID: session.projectID,
        creatorID: session.creatorID,
        driverRuntimeID: session.driverRuntimeID,
        bindingEpoch: session.bindingEpoch,
        createdAt: session.createdAt,
        shareGeneration: 1,
      },
    })
    const sync = async (events: Sync.Event[]) => {
      const canonical = events.map((event) => Sync.Event.parse(event))
      const firstSeq = canonical[0]?.sequence,
        lastSeq = canonical.at(-1)?.sequence
      if (!firstSeq || !lastSeq) throw new Error("The real producer requires a nonempty canonical batch")
      return f.run(() =>
        f.sync({
          schemaVersion: 1,
          sessionID: id,
          projectID: session.projectID,
          bindingEpoch: session.bindingEpoch,
          shareGeneration: 1,
          firstSeq,
          lastSeq,
          events: canonical,
          payloadHash: digest(JSON.stringify({ firstSeq, lastSeq, events: canonical })),
        }),
      )
    }
    const initial = await sync([root])
    expect(initial.nextSeq).toBe(2)
    const valid = await historical(f)
    await Sharing.history(valid.source)
    expect(valid.accepted.has(JSON.stringify(Keys.sharedState(id)))).toBe(true)
    const hash = digest("original upload is absent")
    const content: Sync.Content = {
      kind: "blob",
      blobID: "unuploaded-content",
      hash,
      bytes: 13,
      mediaType: "text/plain",
    }
    const part: Sync.TranscriptPart =
      kind === "nested content"
        ? { type: "text", content }
        : {
            type: "tool",
            callID: "reference-tool-call",
            tool: "fixture",
            status: kind === "tool error" ? "error" : "completed",
            input: kind === "tool input" ? content : { kind: "inline", text: "{}" },
            ...(kind === "tool output" ? { output: content } : {}),
            ...(kind === "tool error" ? { error: content } : {}),
          }
    const events: Sync.Event[] =
      kind === "available blob"
        ? [
            {
              type: "blob",
              sequence: 2,
              blobID: content.blobID,
              kind: "tool-output",
              hash,
              bytes: content.bytes,
              mediaType: content.mediaType,
              state: "available",
            },
          ]
        : [
            {
              type: "message",
              sequence: 2,
              messageID: "reference-message",
              role: "assistant",
              createdAt: 1,
              summary: "",
              integrity: "a".repeat(64),
            },
            {
              type: "part",
              sequence: 3,
              messageID: "reference-message",
              partID: "reference-part",
              part,
              integrity: "b".repeat(64),
            },
          ]
    const acknowledged = await sync(events)
    const last = events.at(-1)
    if (!last) throw new Error("The actual reference batch is empty")
    expect(acknowledged.nextSeq).toBe(last.sequence + 1)
    expect((await f.run(() => Storage.readMany([Keys.sharedBlob(id, 1, hash)])))[0]).toBeUndefined()
    expect(await f.run(() => Storage.count({ prefix: ["organization", "shared-blobs", id] }))).toBe(0)
    await expect(Sharing.history((await historical(f)).source)).rejects.toThrow()
  })
}
