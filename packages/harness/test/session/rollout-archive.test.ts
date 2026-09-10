import { expect, test } from "bun:test"
import { Uint8ArrayWriter, Uint8ArrayReader, ZipWriter, ZipReader } from "@zip.js/zip.js"
import { fixture, complete } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { RolloutArchive } from "../../src/session/rollout/archive"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutAccounting } from "../../src/session/rollout/accounting"
import { SessionImport } from "../../src/session/session-import"
import { Session } from "../../src/session"

test("rollout ZIP restores original evidence with new identities and no new spend", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await complete(call)
    await RolloutLedger.finishRun(call.owner, rootID, "completed")
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    const bytes = await writer.getData()
    const imported = await SessionImport.fromBuffer(bytes)
    try {
      expect(imported.rootSessionID).not.toBe(session.id)
      const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: imported.rootSessionID }
      const snapshot = await RolloutSnapshot.read(owner)
      expect(snapshot.calls).toHaveLength(1)
      expect(snapshot.calls[0].id).not.toBe(call.id)
      expect(snapshot.calls[0].source?.callID).toBe(call.id)
      expect(snapshot.runs[0].id).not.toBe(rootID)
      expect(RolloutAccounting.summarize(snapshot).apiEstimate.total).toBe(0)
      const chunks = []
      for await (const chunk of RolloutArtifact.read(owner, snapshot.attempts[0].response!)) chunks.push(chunk)
      expect(JSON.parse(Buffer.concat(chunks).toString()).usage.output_tokens).toBe(500)
    } finally {
      await Session.remove(imported.rootSessionID)
    }
  })
})

test("rollout export marks active runs as partial and validates every packaged byte", async () => {
  await fixture(async ({ session, rootID }) => {
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    const bytes = await writer.getData()
    const bundle = await RolloutArchive.inspect(new Blob([bytes]))
    expect(bundle.manifest.integrity.complete).toBe(false)
    expect(bundle.manifest.snapshots[0].revision).toBeGreaterThan(0)
    const reader = new ZipReader(new Uint8ArrayReader(bytes))
    const modified = new Uint8ArrayWriter()
    const zip = new ZipWriter(modified)
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue
      const data =
        entry.filename === "transcript.json"
          ? new TextEncoder().encode("{}")
          : await entry.getData(new Uint8ArrayWriter())
      await zip.add(entry.filename, new Uint8ArrayReader(data))
    }
    await zip.close()
    await reader.close()
    await expect(RolloutArchive.inspect(new Blob([await modified.getData()]))).rejects.toThrow("integrity")
  })
})

test("ZIP import rejects unsafe paths before creating sessions", async () => {
  const writer = new Uint8ArrayWriter()
  const zip = new ZipWriter(writer)
  await zip.add("../escape", new Uint8ArrayReader(new Uint8Array([1])))
  await zip.close()
  await expect(SessionImport.fromBuffer(await writer.getData())).rejects.toThrow("path")
})

test("ZIP validation rejects a record whose reference disagrees with packaged artifact bounds", async () => {
  await fixture(async ({ session, rootID }) => {
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    const reader = new ZipReader(new Uint8ArrayReader(await writer.getData()))
    const modified = new Uint8ArrayWriter()
    const zip = new ZipWriter(modified)
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue
      let data = await entry.getData(new Uint8ArrayWriter())
      if (entry.filename === "manifest.json") {
        const manifest = JSON.parse(new TextDecoder().decode(data))
        manifest.snapshots[0].calls[0].request.bytes++
        data = new TextEncoder().encode(JSON.stringify(manifest))
      }
      await zip.add(entry.filename, new Uint8ArrayReader(data))
    }
    await zip.close()
    await reader.close()
    await expect(RolloutArchive.inspect(new Blob([await modified.getData()]))).rejects.toThrow("reference")
  })
})

test("attachments survive source asset removal and rollout import", async () => {
  const { Asset } = await import("../../src/asset/asset")
  const { Identifier } = await import("../../src/id/id")
  const { unlink } = await import("node:fs/promises")
  await fixture(async ({ session, rootID }) => {
    const asset = await Asset.write(Buffer.from("original attachment"), "text/plain")
    await Session.updatePart({
      type: "attachment",
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: rootID,
      url: `asset://${asset}`,
      mime: "text/plain",
    })
    await unlink(Asset.filePath(asset))
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    const result = await SessionImport.fromBuffer(await writer.getData())
    try {
      const messages = await Session.messages({ sessionID: result.rootSessionID, raw: true })
      const part = messages.flatMap((message) => message.parts).find((part) => part.type === "attachment")!
      expect(part.type).toBe("attachment")
      if (part.type !== "attachment") throw new Error("missing attachment")
      expect(part.artifact?.status).toBe("complete")
      expect(await Bun.file(Asset.filePath(part.url.slice("asset://".length))).text()).toBe("original attachment")
    } finally {
      await Session.remove(result.rootSessionID)
    }
  })
})

test("partial ZIP imports missing attachment evidence without accessing its old URL", async () => {
  const { Identifier } = await import("../../src/id/id")
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async ({ session, rootID, call }) => {
    const part = await Session.updatePart({
      type: "attachment",
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: rootID,
      url: "data:text/plain;base64,b3JpZ2luYWw=",
      mime: "text/plain",
    })
    if (part.type !== "attachment" || !part.artifact) throw new Error("missing fixture artifact")
    await Storage.removeTree([...RolloutArtifact.root(call.owner), "artifacts", part.artifact.id])
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    const result = await SessionImport.fromBuffer(await writer.getData())
    try {
      expect(result.warnings.some((warning) => warning.includes("partial"))).toBe(true)
      const messages = await Session.messages({ sessionID: result.rootSessionID, raw: true })
      const attachment = messages.flatMap((message) => message.parts).find((part) => part.type === "attachment")
      expect(attachment?.type === "attachment" && attachment.artifact?.status).toBe("partial")
    } finally {
      await Session.remove(result.rootSessionID)
    }
  })
})

test("ZIP import preserves committed prefixes and re-exported source evidence", async () => {
  const { RolloutJournal } = await import("../../src/session/rollout/journal")
  await fixture(async ({ session, rootID, call }) => {
    await complete(call)
    const artifact = await RolloutArtifact.open(call.owner, "text/plain")
    await artifact.append(new TextEncoder().encode("first"))
    const prefix = await artifact.checkpoint()
    await artifact.append(new TextEncoder().encode("second"))
    const full = await artifact.finish()
    const snapshot = await RolloutSnapshot.read(call.owner)
    await RolloutJournal.write(call.owner, [...RolloutArtifact.root(call.owner), "runs", rootID, "calls", call.id], {
      ...snapshot.calls[0],
      request: prefix,
      response: full,
    })
    await RolloutLedger.finishRun(call.owner, rootID, "completed")
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    const result = await SessionImport.fromBuffer(await writer.getData())
    try {
      const owner = { ...call.owner, sessionID: result.rootSessionID }
      const imported = await RolloutSnapshot.read(owner)
      const chunks = []
      for await (const chunk of RolloutArtifact.read(owner, imported.calls[0].request)) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toBe("first")
      const reexport = new Uint8ArrayWriter()
      await RolloutArchive.write({ sessionID: result.rootSessionID }, reexport)
      const inspected = await RolloutArchive.inspect(new Blob([await reexport.getData()]))
      expect(inspected.manifest.integrity.missing).toEqual([])
    } finally {
      await Session.remove(result.rootSessionID)
    }
  })
})

test("rollout ZIP retains file snapshot objects after the source store is removed", async () => {
  const { Snapshot } = await import("../../src/session/snapshot")
  const { SnapshotStore } = await import("../../src/session/snapshot-store")
  const { Identifier } = await import("../../src/id/id")
  const { ScopeContext } = await import("../../src/scope/context")
  const fs = await import("node:fs/promises")
  await fixture(async ({ session, rootID }) => {
    await Bun.write(`${ScopeContext.current.directory}/evidence.txt`, "snapshot evidence")
    const hash = await Snapshot.track(session.id)
    if (!hash) throw new Error("missing snapshot fixture")
    await Session.updatePart({
      type: "step-start",
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: rootID,
      snapshot: hash,
    })
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    await Session.remove(session.id)
    await fs.rm(SnapshotStore.root(session.scope.id), { recursive: true, force: true })
    const restored = await SessionImport.fromBuffer(await writer.getData())
    try {
      expect(await SnapshotStore.owns(session.scope.id, restored.rootSessionID, hash)).toBe(true)
      expect(
        await SnapshotStore.command(SnapshotStore.repository(session.scope.id), ["show", `${hash}:evidence.txt`]),
      ).toBe("snapshot evidence")
    } finally {
      await Session.remove(restored.rootSessionID)
    }
  })
})

test("a partial manifest cannot hide an undeclared missing artifact reference", async () => {
  await fixture(async ({ session, rootID }) => {
    const writer = new Uint8ArrayWriter()
    await RolloutArchive.write({ sessionID: session.id, runID: rootID }, writer)
    const reader = new ZipReader(new Uint8ArrayReader(await writer.getData()))
    const output = new Uint8ArrayWriter()
    const zip = new ZipWriter(output)
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue
      let data = await entry.getData(new Uint8ArrayWriter())
      if (entry.filename === "manifest.json") {
        const manifest = JSON.parse(new TextDecoder().decode(data))
        manifest.integrity = { complete: false, missing: [] }
        manifest.artifacts = []
        data = new TextEncoder().encode(JSON.stringify(manifest))
      }
      await zip.add(entry.filename, new Uint8ArrayReader(data))
    }
    await zip.close()
    await reader.close()
    await expect(RolloutArchive.inspect(new Blob([await output.getData()]))).rejects.toThrow(
      "missing referenced artifact",
    )
  })
})
