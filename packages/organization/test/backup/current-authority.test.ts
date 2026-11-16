import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationCurrentAuthority as Current } from "../../src/backup-recovery"
import { fixture, password } from "../support/organization"

test("a live frozen service proves its final authority suffix and actual native settings only during its callback", async () => {
  const clients = [
    { clientID: "desktop", kind: "desktop" as const, redirectUri: "synergy://organization-auth/callback" as const },
  ]
  await using service = await fixture(undefined, { clientAuthentication: { clients } })
  const owner = await service.initialize()
  const before = await service.service.maintenance.run(() => AuthorityJournal.head())
  expect(
    (await owner.request("POST", "/auth/password", { currentPassword: password, password: "new authority password" }))
      .status,
  ).toBe(200)
  const after = await service.service.maintenance.run(() => AuthorityJournal.head())
  expect(after.sequence).toBeGreaterThan(before.sequence)
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "current-authority-"))
  const keys = {
    async current() {
      return { version: "fixture", key: Buffer.alloc(32, 17) }
    },
    async resolve(version: string) {
      if (version !== "fixture") throw new Error("Wrong recovery key")
      return Buffer.alloc(32, 17)
    },
  }
  let escaped: Current.Source | undefined
  try {
    await service.service.maintenance.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "current-authority",
        actor: {
          kind: "system",
          subjectID: "host",
          displayName: "Host",
          clientKind: "system",
          requestID: "current-authority",
        },
      })
      let prematurelyCalled = false
      await expect(
        Current.withSource(
          { lease, directory: path.join(directory, "draining"), after: before, keys, buildVersion: "fixture" },
          async () => {
            prematurelyCalled = true
          },
        ),
      ).rejects.toThrow("frozen")
      expect(prematurelyCalled).toBe(false)
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      try {
        const input = {
          lease,
          directory: path.join(directory, "valid"),
          after: structuredClone(before),
          keys,
          buildVersion: "fixture",
        }
        await Current.withSource(input, async (source) => {
          escaped = source
          const info = Current.describe(source)
          expect(info.checkpoint).toEqual(after)
          expect(info.maintenance.phase).toBe("frozen")
          expect(info.clientDefinitionsHash).toBe(createHash("sha256").update(JSON.stringify(clients)).digest("hex"))
          info.checkpoint.sequence = 0
          expect(Current.describe(source).checkpoint).toEqual(after)
          const captured: { guard?: () => void } = {}
          await Current.withCaptured(source, async (fixed) => {
            fixed.assertLive()
            captured.guard = fixed.assertLive
            fixed.namespace.expected.archiveID = "mutated-description"
          })
          const guard = captured.guard
          if (!guard) throw new Error("The actual source did not issue a capture lifetime")
          expect(guard).toThrow("callback")
          expect(() => Current.describe({ ...source })).toThrow("original")
          await expect(
            Storage.provide({ ...Storage.current(), artifactDirectory: path.join(directory, "foreign") }, () =>
              Current.verify(source),
            ),
          ).rejects.toThrow("primary Store")
          input.after.sequence = 999
          await Current.verify(source)
          expect(Current.describe(source).after?.sequence).not.toBe(999)
          expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
        })
        expect(() => Current.describe(escaped!)).toThrow("callback")
        await expect(Current.verify(escaped!)).rejects.toThrow("callback")
        await expect(
          Current.withSource(
            { ...input, directory: path.join(directory, "forked"), after: { ...before, tailHash: "0".repeat(64) } },
            async () => {},
          ),
        ).rejects.toThrow("authority")
        const controller = new AbortController()
        const cancelled = new Error("Original source authority cancelled during encryption")
        let cancelledCalled = false
        await expect(
          Current.withSource(
            {
              ...input,
              after: before,
              directory: path.join(directory, "cancelled"),
              signal: controller.signal,
              keys: {
                async current() {
                  controller.abort(cancelled)
                  return keys.current()
                },
                resolve: keys.resolve,
              },
            },
            async () => {
              cancelledCalled = true
            },
          ),
        ).rejects.toBe(cancelled)
        expect(cancelledCalled).toBe(false)
        expect(await AuthorityJournal.head()).toEqual(after)
      } finally {
        await RuntimeMaintenance.release(lease)
      }
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)
