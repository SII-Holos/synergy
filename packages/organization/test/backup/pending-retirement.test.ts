import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OrganizationSourceRetirement as Retirement } from "../../src/backup/source-retirement"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import { OrganizationRecovery as Recovery } from "../../src/backup/recovery"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import * as Signing from "../../src/signing"
import { pendingKeys, withPendingTarget } from "../support/pending-retirement-child"
import {
  openOrganizationPendingRetirement,
  openOrganizationRecovery,
  openOrganizationService,
  openOrganizationSourceRetirement,
} from "../../src/service"

test("a second process exiting after the original reservation leaves exact cold completion available", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "reserved-pending-")))
  try {
    for (const reserved of [false, true]) {
      const child = Bun.spawn([process.execPath, "./test/support/pending-retirement-child.ts"], {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SYNERGY_PENDING_RETIREMENT_DIRECTORY: directory,
          ...(reserved ? { SYNERGY_PENDING_RESERVATION_CRASH: "1" } : {}),
        },
      })
      const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
      if (exit !== 0) throw new Error(error)
    }
    const selector = await Bun.file(path.join(directory, "selector.json")).json()
    const reference = Retirement.Reference.parse(selector.reference)
    expect((await Bun.file(path.join(selector.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(2)
    await using cold = await openOrganizationSourceRetirement({ home: selector.home, reference })
    expect(await cold.run(() => RuntimeMaintenance.status())).toEqual(reference.current.maintenance)
    expect(
      await cold.run(() => RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)),
    ).toBeDefined()
    const receipt = await cold.complete()
    expect(await cold.run(() => Promise.resolve(Retirement.describe(receipt)))).toEqual(reference)
    expect((await Bun.file(path.join(selector.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(4)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("a real process exiting after durable Reference but before reservation can resume the same frozen source", async () => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "pending-retirement-")),
  )
  let home: string | undefined
  try {
    const child = Bun.spawn([process.execPath, "./test/support/pending-retirement-child.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SYNERGY_PENDING_RETIREMENT_DIRECTORY: directory },
    })
    const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (status !== 0) throw new Error(error)
    const selector = await Bun.file(path.join(directory, "selector.json")).json()
    home = selector.home
    const reference = Retirement.Reference.parse(selector.reference)
    const copied = path.join(directory, "copied-source")
    await fs.cp(selector.home, copied, { recursive: true })
    await expect(openOrganizationSourceRetirement({ home: selector.home, reference })).rejects.toThrow("reservation")
    await using cold = await openOrganizationPendingRetirement({ home: selector.home, reference })
    expect("fetch" in cold).toBe(false)
    const before = await cold.run(() => RuntimeMaintenance.status())
    expect(before).toEqual(reference.current.maintenance)
    await expect(openOrganizationPendingRetirement({ home: selector.home, reference })).rejects.toThrow("already owns")
    await expect(
      cold.run(() => RuntimeMaintenance.withRetirementSource({ evidence: { ...reference } }, async () => {})),
    ).rejects.toThrow("verified fixed H1 admission")
    const namespace = {
      directory: path.join(directory, "h1", "records"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "records", "manifest.json")).json(),
      ),
    }
    const native = {
      directory: path.join(directory, "h1", "native"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "native", "manifest.json")).json(),
      ),
    }
    using material = spyOn(Signing, "prepareSigningMaterial").mockImplementation(() => {
      throw new Error("Cold source recovery cannot mint another inactive signing key")
    })
    using keyCurrent = spyOn(pendingKeys, "current").mockImplementation(() => {
      throw new Error("Cold source recovery cannot select new key material")
    })
    await withPendingTarget(directory, async (target, targetReference, original) => {
      expect(targetReference).toEqual(reference.target)
      await expect(openOrganizationPendingRetirement({ home: copied, reference })).rejects.toThrow("physical identity")
      expect(
        await cold.run(() => RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)),
      ).toBeUndefined()
      const cancelled = new AbortController()
      const reason = new Error("Cancel before the actual original reservation")
      cancelled.abort(reason)
      await expect(
        Current.resumeRetirement({
          source: cold.source,
          target: original,
          namespace,
          native,
          keys: pendingKeys,
          signal: cancelled.signal,
        }),
      ).rejects.toBe(reason)
      await expect(
        Current.resumeRetirement({
          source: cold.source,
          target: original,
          namespace: { ...namespace, expected: { ...namespace.expected, archiveID: "another-h1" } },
          native,
          keys: pendingKeys,
        }),
      ).rejects.toThrow("selector")
      expect(
        await cold.run(() => RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)),
      ).toBeUndefined()
      const resume = RuntimeMaintenance.withRetirementSource
      using inspected = spyOn(RuntimeMaintenance, "withRetirementSource").mockImplementationOnce((input, body) =>
        resume(input, async (lease) => {
          await expect(RuntimeMaintenance.release(lease)).rejects.toThrow("cannot release")
          await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow("another drainage")
          await expect(
            RuntimeMaintenance.withFrozen(lease, () => RuntimeMaintenance.reserveRetirement(lease, "0".repeat(64))),
          ).rejects.toThrow("another reference")
          return body(lease)
        }),
      )
      const receipt = await Current.resumeRetirement({
        source: cold.source,
        target: original,
        namespace,
        native,
        keys: pendingKeys,
      })
      expect(await cold.run(() => Promise.resolve(Retirement.describe(receipt)))).toEqual(reference)
      expect(await cold.run(() => RuntimeMaintenance.status())).toEqual(before)
      expect(
        (await cold.run(() => RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)))
          ?.referenceHash,
      ).toMatch(/^[a-f0-9]{64}$/)
      await cold.run(() => Recovery.reconstructCold({ source: receipt, target, namespace, native, keys: pendingKeys }))
      const retry = await Current.resumeRetirement({
        source: cold.source,
        target: original,
        namespace,
        native,
        keys: pendingKeys,
      })
      expect(await cold.run(() => Promise.resolve(Retirement.describe(retry)))).toEqual(reference)
      await cold.run(() =>
        Recovery.publishServiceOnly({
          source: retry,
          target,
          namespace,
          native,
          keys: pendingKeys,
          publicOrigin: "https://recovered.example",
        }),
      )
    })
    await using completion = await openOrganizationRecovery({ home: path.join(directory, "target") })
    await completion.run(() => Recovery.completeServicePublication(reference.target.installationID))
    await completion.close()
    await using ordinary = await openOrganizationService({ home: path.join(directory, "target") })
    expect((await ordinary.fetch(new Request("https://recovered.example/org/v1/ready"))).status).toBe(200)
    expect((await Bun.file(path.join(selector.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(4)
    expect(material).not.toHaveBeenCalled()
    expect(keyCurrent).not.toHaveBeenCalled()
  } finally {
    if (home) await fs.rm(home, { recursive: true, force: true })
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("observer cancellation after reservation drains the real fence before the restricted source closes", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "accepted-pending-")))
  try {
    const child = Bun.spawn([process.execPath, "./test/support/pending-retirement-child.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SYNERGY_PENDING_RETIREMENT_DIRECTORY: directory },
    })
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (exit !== 0) throw new Error(error)
    const selector = await Bun.file(path.join(directory, "selector.json")).json()
    const reference = Retirement.Reference.parse(selector.reference)
    await using cold = await openOrganizationPendingRetirement({ home: selector.home, reference })
    const namespace = {
      directory: path.join(directory, "h1", "records"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "records", "manifest.json")).json(),
      ),
    }
    const native = {
      directory: path.join(directory, "h1", "native"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "native", "manifest.json")).json(),
      ),
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const complete = Retirement.complete
    using held = spyOn(Retirement, "complete").mockImplementationOnce(async (value) => {
      entered.resolve()
      await release.promise
      return complete(value)
    })
    await withPendingTarget(directory, async (_target, _reference, original) => {
      const controller = new AbortController()
      const work = Current.resumeRetirement({
        source: cold.source,
        target: original,
        namespace,
        native,
        keys: pendingKeys,
        signal: controller.signal,
      })
      let closing: Promise<void> | undefined
      try {
        await entered.promise
        expect(
          await cold.run(() => RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)),
        ).toBeDefined()
        controller.abort(new Error("Observer left after permanent intent committed"))
        let closed = false
        closing = cold.close().then(() => {
          closed = true
        })
        await Promise.resolve()
        expect(closed).toBe(false)
      } finally {
        release.resolve()
      }
      expect(await work).toBeDefined()
      await closing
      const ownership = HomeOwnershipFile.RetirementInfo.parse(
        await Bun.file(path.join(selector.home, ".synergy", "home-ownership.json")).json(),
      )
      expect(ownership.maintenanceID).toBe(reference.current.maintenance.maintenanceID)
    })
    await using retry = await openOrganizationSourceRetirement({ home: selector.home, reference })
    const receipt = await retry.complete()
    expect(await retry.run(() => Promise.resolve(Retirement.describe(receipt)))).toEqual(reference)
    expect(await retry.run(() => RuntimeMaintenance.status())).toEqual(reference.current.maintenance)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("a still-live original process excludes cold source takeover", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "live-pending-")))
  const child = Bun.spawn([process.execPath, "./test/support/pending-retirement-child.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SYNERGY_PENDING_RETIREMENT_DIRECTORY: directory, SYNERGY_PENDING_WRITER_LIVE: "1" },
  })
  try {
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toContain("selector-ready")
    reader.releaseLock()
    const selector = await Bun.file(path.join(directory, "selector.json")).json()
    await expect(
      openOrganizationPendingRetirement({
        home: selector.home,
        reference: Retirement.Reference.parse(selector.reference),
      }),
    ).rejects.toThrow("already owns")
    expect((await Bun.file(path.join(selector.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(2)
  } finally {
    child.kill()
    await child.exited
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("fixed unknown native calls still block before any cold reservation", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "unknown-pending-")))
  try {
    const child = Bun.spawn([process.execPath, "./test/support/pending-retirement-child.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SYNERGY_PENDING_RETIREMENT_DIRECTORY: directory, SYNERGY_PENDING_UNKNOWN_CALL: "1" },
    })
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (exit !== 0) throw new Error(error)
    const selector = await Bun.file(path.join(directory, "selector.json")).json()
    const reference = Retirement.Reference.parse(selector.reference)
    await using cold = await openOrganizationPendingRetirement({ home: selector.home, reference })
    const namespace = {
      directory: path.join(directory, "h1", "records"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "records", "manifest.json")).json(),
      ),
    }
    const native = {
      directory: path.join(directory, "h1", "native"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "native", "manifest.json")).json(),
      ),
    }
    await withPendingTarget(directory, async (_target, _reference, original) => {
      await expect(
        Current.resumeRetirement({ source: cold.source, target: original, namespace, native, keys: pendingKeys }),
      ).rejects.toThrow("unclassified-native-call")
      expect(
        await cold.run(() => RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)),
      ).toBeUndefined()
      expect((await Bun.file(path.join(selector.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(2)
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)
