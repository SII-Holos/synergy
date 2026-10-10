import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransfer } from "../../src/session/transfer"
import { Storage } from "../../src/storage/storage"
import { SessionTransferArchive } from "../../src/session/transfer-archive"
import { SessionManager } from "../../src/session/manager"
import { StoredToolOutput } from "../../src/tool/stored-output"
import { Asset } from "../../src/asset/asset"
import { Truncate } from "../../src/tool/truncation"
import { Identifier } from "../../src/id/id"
import { SessionDrive } from "../../src/session/drive"

async function fixture() {
  const sourceHome = await tmpdir()
  const targetHome = await tmpdir()
  let source = await testRuntime({ home: sourceHome.path })
  let target = await testRuntime({ home: targetHome.path })
  const inSource = <T>(fn: () => Promise<T>) =>
    source.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn }))
  const inTarget = <T>(fn: () => Promise<T>) =>
    target.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn }))
  const session = await inSource(async () => {
    const session = await Session.create({ workspace: null })
    await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
    await Storage.write(["sessions", "home", session.id, "inbox", "retained"], { completedResult: "do not recompute" })
    await Storage.writeBinary(
      ["sessions", "home", session.id, "rollout", "blobs", "fixture"],
      new Uint8Array([0, 255, 17]),
    )
    return session
  })
  const targetID = await inTarget(() => SessionTransfer.host())
  return {
    source,
    target,
    inSource,
    inTarget,
    session,
    targetID: targetID.id,
    async reopen() {
      await source.close()
      await target.close()
      source = await testRuntime({ home: sourceHome.path })
      target = await testRuntime({ home: targetHome.path })
    },
    async [Symbol.asyncDispose]() {
      await source.close()
      await target.close()
      await sourceHome[Symbol.asyncDispose]()
      await targetHome[Symbol.asyncDispose]()
    },
  }
}

describe("paused Session transfer", () => {
  test("rejects malformed archives before reserving or publishing a Session", async () => {
    await using f = await fixture()
    await expect(f.inTarget(() => SessionTransfer.stage(new Blob(["not a ZIP"])))).rejects.toBeInstanceOf(
      SessionTransfer.Rejected,
    )
    await expect(f.inTarget(() => Session.get(f.session.id))).rejects.toThrow()
  })

  test("stages privately, cuts over once and retains identity, pause and exact evidence", async () => {
    await using f = await fixture()
    const prepared = await f.inSource(() =>
      SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
    )
    const blob = await f.inSource(() => SessionTransfer.archive(f.session.id))
    const receipt = await f.inTarget(() => SessionTransfer.stage(blob))
    await expect(f.inTarget(() => Session.get(f.session.id))).rejects.toThrow()
    await expect(f.inSource(() => SessionLifecycle.clear(f.session.id))).rejects.toThrow("transfer")
    await expect(
      f.inSource(() => Storage.transaction((tx) => tx.write(["sessions", "home", f.session.id, "inbox", "late"], {}))),
    ).rejects.toThrow("transfer")
    const activation = await f.inSource(() => SessionTransfer.commit(f.session.id, receipt))
    const activated = await f.inTarget(() => SessionTransfer.activate(activation))
    expect(activated.migrationID).toBe(prepared.migrationID)
    expect(await f.inTarget(() => SessionTransfer.activate(activation))).toEqual(activated)
    await f.inSource(() => SessionTransfer.complete(f.session.id, activated))
    expect(await f.inTarget(() => Session.get(f.session.id))).toMatchObject({
      id: f.session.id,
      paused: { reason: "interrupted" },
      environmentID: null,
    })
    expect(
      await f.inTarget(() =>
        Storage.read<{ completedResult: string }>(["sessions", "home", f.session.id, "inbox", "retained"]),
      ),
    ).toEqual({ completedResult: "do not recompute" })
    expect(
      await f.inTarget(() => Storage.readBinary(["sessions", "home", f.session.id, "rollout", "blobs", "fixture"])),
    ).toEqual(new Uint8Array([0, 255, 17]))
    expect(await f.inTarget(() => SessionDrive.request(f.session.id, "migration-test", { force: true }))).toBe(false)
    await expect(f.inSource(() => SessionLifecycle.clear(f.session.id))).rejects.toThrow("transfer")
    expect(await f.inSource(() => Session.get(f.session.id))).toMatchObject({
      id: f.session.id,
      paused: { reason: "interrupted" },
    })
    await f.inTarget(() => SessionLifecycle.clear(f.session.id))
    expect((await f.inTarget(() => Session.get(f.session.id))).paused).toBeUndefined()
  })

  test("precommit cancellation restores the source; an old staged bundle cannot activate", async () => {
    await using f = await fixture()
    await f.inSource(() =>
      SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
    )
    const receipt = await f.inTarget(() =>
      f.inSource(() => SessionTransfer.archive(f.session.id)).then(SessionTransfer.stage),
    )
    await f.inSource(() => SessionTransfer.cancel(f.session.id))
    await expect(f.inSource(() => SessionTransfer.commit(f.session.id, receipt))).rejects.toThrow()
    await f.inSource(() => SessionLifecycle.clear(f.session.id))
    await expect(f.inTarget(() => Session.get(f.session.id))).rejects.toThrow()
  })

  test("rejects unpaused sessions and a receipt for another destination", async () => {
    await using f = await fixture()
    await f.inSource(() => SessionLifecycle.clear(f.session.id))
    await expect(
      f.inSource(() =>
        SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
      ),
    ).rejects.toThrow("paused")
    await f.inSource(() => SessionLifecycle.pause({ sessionID: f.session.id, reason: "interrupted" }))
    await f.inSource(() =>
      SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
    )
    const receipt = await f.inTarget(() =>
      f.inSource(() => SessionTransfer.archive(f.session.id)).then(SessionTransfer.stage),
    )
    await expect(
      f.inSource(() => SessionTransfer.commit(f.session.id, { ...receipt, targetID: "wrong-host" })),
    ).rejects.toThrow()
    await f.inSource(() => SessionTransfer.cancel(f.session.id))
  })
  test("reopens after cutover and completes the original prepared destination", async () => {
    await using f = await fixture()
    await f.inSource(() =>
      SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
    )
    const blob = await f.inSource(() => SessionTransfer.archive(f.session.id))
    const receipt = await f.inTarget(() => SessionTransfer.stage(blob))
    const proof = await f.inSource(() => SessionTransfer.commit(f.session.id, receipt))
    await f.reopen()
    await expect(f.inSource(() => SessionTransfer.cancel(f.session.id))).rejects.toThrow("cannot roll back")
    await expect(f.inSource(() => SessionLifecycle.clear(f.session.id))).rejects.toThrow("transfer")
    expect(await f.inTarget(() => SessionTransfer.destination(proof.migrationID))).toEqual(receipt)
    const resumedProof = await f.inSource(() => SessionTransfer.commit(f.session.id, receipt))
    expect(resumedProof).toEqual(proof)
    const activated = await f.inTarget(() => SessionTransfer.activate(resumedProof))
    await f.inSource(() => SessionTransfer.complete(f.session.id, activated))
    expect((await f.inTarget(() => Session.get(f.session.id))).paused).toBeDefined()
  })

  test("rejects forged activation, occupied identities and source deletion while frozen", async () => {
    await using f = await fixture()
    await f.inSource(() =>
      SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
    )
    const blob = new Blob([await (await f.inSource(() => SessionTransfer.archive(f.session.id))).arrayBuffer()])
    const receipt = await f.inTarget(() => SessionTransfer.stage(blob))
    await expect(f.inTarget(() => Session.create({ id: f.session.id, workspace: null }))).rejects.toThrow("transfer")
    await expect(f.inSource(() => Storage.removeTree(["sessions", "home", f.session.id]))).rejects.toThrow("transfer")
    await expect(
      f.inTarget(() => SessionTransfer.activate({ ...receipt, phase: "prepared", secret: "0".repeat(64) })),
    ).rejects.toThrow("activation")
    const cancellation = await f.inSource(() => SessionTransfer.cancel(f.session.id))
    await f.inTarget(() => SessionTransfer.discard(cancellation))
    await f.inTarget(() => Session.create({ id: f.session.id, workspace: null }))
    await expect(f.inTarget(() => SessionTransfer.stage(blob))).rejects.toThrow("already owns")
  })

  test("resumes a receiving reservation after restart and rejects broad destination deletion", async () => {
    await using f = await fixture()
    const prepared = await f.inSource(() =>
      SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
    )
    const blob = await f.inSource(() => SessionTransfer.archive(f.session.id))
    await using archive = await SessionTransferArchive.open(blob)
    const receipt = {
      migrationID: prepared.migrationID,
      sessionID: f.session.id,
      sourceID: prepared.sourceID,
      targetID: f.targetID,
      digest: prepared.digest!,
      phase: "prepared" as const,
    }
    await f.inTarget(() =>
      Storage.write(["session_transfer_reservation", f.session.id], {
        version: 1,
        receipt,
        migrationID: prepared.migrationID,
        activationHash: archive.manifest.activationHash,
        cancellationHash: archive.manifest.cancellationHash,
        scopeID: "home",
      }),
    )
    await f.reopen()
    await expect(f.inTarget(() => Storage.removeTree(["sessions"]))).rejects.toThrow("transfer")
    await expect(
      f.inTarget(() => Storage.transaction((tx) => tx.pruneTree(["sessions", "home", f.session.id]))),
    ).rejects.toThrow("transfer")
    expect(await f.inTarget(() => SessionTransfer.stage(blob))).toEqual(receipt)
    const proof = await f.inSource(() => SessionTransfer.cancel(f.session.id))
    await expect(f.inTarget(() => SessionTransfer.discard({ ...proof, secret: "0".repeat(64) }))).rejects.toThrow(
      "cancellation",
    )
    await f.inTarget(() => SessionTransfer.discard(proof))
    await f.inTarget(() => Session.create({ id: f.session.id, workspace: null }))
  })
  test("protects execution and atomic mutation batches while unrelated owners stay writable", async () => {
    await using f = await fixture()
    await f.inSource(() =>
      SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
    )
    let executed = false
    await expect(
      f.inSource(() =>
        SessionManager.run(f.session.id, async () => {
          executed = true
        }),
      ),
    ).rejects.toThrow("transfer")
    expect(executed).toBe(false)
    await expect(
      f.inSource(() =>
        Storage.transaction((tx) =>
          tx.writeMany([
            { key: ["scratch", "batch"], value: 1 },
            { key: ["sessions", "home", f.session.id, "test"], value: 2 },
          ]),
        ),
      ),
    ).rejects.toThrow("transfer")
    await expect(f.inSource(() => Storage.read(["scratch", "batch"]))).rejects.toThrow()
    await expect(
      f.inSource(() => Storage.writeBinary(["sessions", "home", f.session.id, "blob"], new Uint8Array([1]))),
    ).rejects.toThrow("transfer")
    await f.inSource(() => Storage.removeTree(["sessions", "unrelated_scope"]))
    const other = await f.inSource(() => Session.create({ workspace: null }))
    await f.inSource(() =>
      Session.update(other.id, (draft) => {
        draft.title = "unrelated task still writable"
      }),
    )
    expect((await f.inSource(() => Session.get(other.id))).title).toBe("unrelated task still writable")
  })

  test.each(["stored", "native", "alias"])(
    "retains completed tool results, %s full outputs and assets without replay",
    async (kind) => {
      await using f = await fixture()
      const rootID = Identifier.ascending("message"),
        messageID = Identifier.ascending("message"),
        partID = Identifier.ascending("part")
      const evidence = await f.inSource(async () => {
        const output =
          kind === "native"
            ? ((await Truncate.output("completed expensive computation", { maxBytes: 1 })) as { outputPath: string })
                .outputPath
            : kind === "alias"
              ? (await StoredToolOutput.save("tool_transfer", "completed expensive computation", [
                  "/historical/tool_transfer",
                ]),
                "/historical/tool_transfer")
              : await StoredToolOutput.save("tool_transfer", "completed expensive computation")
        const asset = await Asset.write(Buffer.from([0, 255, 4]), "application/octet-stream")
        await Session.updateMessage({
          id: rootID,
          sessionID: f.session.id,
          role: "user",
          isRoot: true,
          rootID,
          agent: "general",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
        })
        await Session.updateMessage({
          id: messageID,
          sessionID: f.session.id,
          role: "assistant",
          rootID,
          parentID: rootID,
          agent: "general",
          mode: "general",
          modelID: "test",
          providerID: "test",
          path: { cwd: "/fixture", root: "/fixture" },
          time: { created: 1, completed: 2 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const part = {
          id: partID,
          messageID,
          sessionID: f.session.id,
          type: "tool" as const,
          callID: "completed-tool",
          tool: "bash",
          state: {
            status: "completed" as const,
            input: { command: "expensive computation", outputPath: "/requested/workspace/result.txt" },
            output: "saved result",
            title: "Compute",
            metadata: { outputPath: output, asset: `asset://${asset}` },
            time: { start: 1, end: 2 },
          },
        }
        await Session.updatePart(part)
        return { output, asset, part }
      })
      await f.inSource(() =>
        SessionTransfer.prepare(f.session.id, { targetID: f.targetID, migrationID: crypto.randomUUID() }),
      )
      const receipt = await f.inTarget(() =>
        f.inSource(() => SessionTransfer.archive(f.session.id)).then(SessionTransfer.stage),
      )
      const proof = await f.inSource(() => SessionTransfer.commit(f.session.id, receipt))
      await f.inTarget(() => SessionTransfer.activate(proof))
      expect(
        (await f.inTarget(() => Session.messages({ sessionID: f.session.id, raw: true }))).find(
          (message) => message.info.id === messageID,
        )!.parts[0],
      ).toMatchObject(evidence.part)
      expect((await f.inTarget(() => StoredToolOutput.read({ reference: evidence.output }))).text).toBe(
        "completed expensive computation",
      )
      const asset = await f.inTarget(() => Asset.read(evidence.asset))
      expect(new Uint8Array(await asset!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 4]))
    },
  )
})
