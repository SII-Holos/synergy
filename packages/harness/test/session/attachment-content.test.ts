import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { Identifier } from "../../src/id/id"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutAttachment } from "../../src/session/rollout/attachment"
import { Asset } from "../../src/asset/asset"
import { PartContent } from "../../src/session/part-content"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import type { MessageV2 } from "../../src/session/message-v2"

async function fixture(bytes: Uint8Array, kind: "complete" | "partial" | "absent" = "complete") {
  const session = await Session.create({ workspace: null, environmentID: null })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "user",
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
    rootID: messageID,
    time: { created: 1 },
  })
  const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
  const writer = kind === "absent" ? undefined : await RolloutArtifact.open(owner, "application/octet-stream")
  await writer?.append(bytes)
  const artifact = writer ? (kind === "partial" ? await writer.checkpoint() : await writer.finish()) : undefined
  const part: MessageV2.AttachmentPart = {
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID,
    type: "attachment",
    mime: "application/octet-stream",
    filename: "../../retained.bin",
    artifact,
    url: kind === "absent" ? "https://unavailable.invalid/remote.bin" : "asset://not-a-download-authority.bin",
  }
  await Session.updatePart(part)
  const target = { sessionID: session.id, messageID, partID: part.id }
  const { version } = await SessionHistory.partFieldDescriptor(target)
  return { session, part, target, version, artifact }
}

async function within(run: () => Promise<void>) {
  await using runtime = await testRuntime()
  await runtime.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn: run }))
}

test(
  "serves canonical attachment binary ranges without global Assets or full Part hydration",
  () =>
    within(async () => {
      const bytes = Uint8Array.from({ length: 90_001 }, (_, index) => index % 256)
      const value = await fixture(bytes)
      using noAssets = spyOn(Asset, "materialize").mockImplementation(() => {
        throw new Error("Global Assets are not attachment authority")
      })
      using noCapture = spyOn(RolloutAttachment, "capture").mockImplementation(() => {
        throw new Error("Reads cannot capture an attachment")
      })
      using noHydration = spyOn(PartContent, "hydrate").mockImplementation(() => {
        throw new Error("Reads cannot hydrate a whole Part")
      })
      const first = await SessionHistory.attachmentContent({
        ...value.target,
        version: value.version,
        offset: 0,
        length: 65_536,
      })
      expect(first.state).toBe("ready")
      if (first.state !== "ready") throw new Error("Expected retained attachment bytes")
      expect(first.data).toEqual(bytes.subarray(0, 65_536))
      expect(first.descriptor).toEqual({
        version: value.version,
        filename: "retained.bin",
        mediaType: "application/octet-stream",
        bytes: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      })
      expect(first.nextOffset).toBe(65_536)
      expect(first.complete).toBe(false)
      expect(JSON.stringify(first.descriptor)).not.toContain("asset:")
      const last = await SessionHistory.attachmentContent({
        ...value.target,
        version: value.version,
        offset: first.nextOffset,
        length: 65_536,
      })
      expect(last.state).toBe("ready")
      if (last.state !== "ready") throw new Error("Expected final attachment bytes")
      expect(last.data).toEqual(bytes.subarray(65_536))
      expect(last.complete).toBe(true)
      await expect(
        SessionHistory.attachmentContent({ ...value.target, version: value.version, length: 65_537 }),
      ).rejects.toThrow()
    }),
  15_000,
)

test(
  "attachment producers and readers reject another Session's artifact reference",
  () =>
    within(async () => {
      const first = await fixture(new Uint8Array([1, 2, 3]))
      const foreign = await fixture(new Uint8Array([7, 8, 9]))
      await expect(Session.updatePart({ ...first.part, artifact: foreign.artifact })).rejects.toThrow()
      await expect(
        SessionHistory.attachmentContent({ ...first.target, sessionID: foreign.session.id, version: first.version }),
      ).rejects.toThrow()
      await Storage.write(
        StoragePath.messagePart(
          Identifier.asScopeID(first.session.scope.id),
          Identifier.asSessionID(first.session.id),
          Identifier.asMessageID(first.target.messageID),
          Identifier.asPartID(first.part.id),
        ),
        { ...first.part, artifact: foreign.artifact },
      )
      const { version } = await SessionHistory.partFieldDescriptor(first.target)
      const denied = await SessionHistory.attachmentContent({ ...first.target, version })
      expect(denied.state).toBe("unavailable")
    }),
  15_000,
)

test(
  "partial and absent attachment evidence remain unavailable without capturing a URL",
  () =>
    within(async () => {
      const values = [await fixture(new Uint8Array([1, 2]), "partial"), await fixture(new Uint8Array([3]), "absent")]
      using noAssets = spyOn(Asset, "materialize").mockImplementation(() => {
        throw new Error("Reads cannot resolve an Asset URL")
      })
      using noCapture = spyOn(RolloutAttachment, "capture").mockImplementation(() => {
        throw new Error("Reads cannot capture missing evidence")
      })
      using noBytes = spyOn(RolloutArtifact, "readRange").mockImplementation(() => {
        throw new Error("Unavailable evidence has no byte read")
      })
      for (const [index, value] of values.entries()) {
        const result = await SessionHistory.attachmentContent({ ...value.target, version: value.version })
        expect(result).toEqual({
          state: "unavailable",
          version: value.version,
          reason: index === 0 ? "partial" : "not_retained",
        })
      }
    }),
  15_000,
)

test(
  "a changed canonical Part rejects both an old attachment version and a held old range",
  () =>
    within(async () => {
      const value = await fixture(new Uint8Array([1, 2, 3]))
      await Session.updatePart({ ...value.part, filename: "changed.bin" })
      await expect(SessionHistory.attachmentContent({ ...value.target, version: value.version })).rejects.toThrow(
        "changed",
      )
      const { version } = await SessionHistory.partFieldDescriptor(value.target)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const readRange = RolloutArtifact.readRange
      using held = spyOn(RolloutArtifact, "readRange").mockImplementation(async (...args) => {
        const data = await readRange(...args)
        entered.resolve()
        await release.promise
        return data
      })
      const result = SessionHistory.attachmentContent({ ...value.target, version }).catch((error: unknown) => error)
      try {
        await entered.promise
        await Session.updatePart({ ...value.part, filename: "changed-again.bin" })
      } finally {
        release.resolve()
      }
      expect(await result).toBeInstanceOf(SessionHistory.PartFieldConflict)
    }),
  15_000,
)
