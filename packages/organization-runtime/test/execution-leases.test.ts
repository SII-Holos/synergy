import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { OrganizationExecutionLeases as Leases } from "../src/execution-leases"
import { executionFixture } from "./support/execution"
import { OrganizationRuntimeError } from "../src/error"

test("cleanup intents fence the native Store and artifacts and settle only their exact generation", async () => {
  await using f = await executionFixture({ execution: true })
  const proof = await f.binding()
  const grant = await f.connection.resources.bind(proof)
  const foreign = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(f.root, "foreign-cleanup.sqlite"),
    namespace: "foreign",
  })
  try {
    await f.runtime.run(async () => {
      const originalProbe = (await Leases.page(grant.runtimeID)).items[0]!
      const intent = await Leases.begin(proof)
      const known = await Leases.confirm(intent, grant)
      const original = Storage.current()
      for (const handle of [
        { store: foreign, artifactDirectory: path.join(f.root, "foreign-artifacts") },
        { store: original.store, artifactDirectory: path.join(f.root, "redirected-artifacts") },
      ])
        await Storage.provide(handle, async () => {
          await expect(Leases.begin(proof)).rejects.toThrow("storage owner")
          await expect(Leases.page(grant.runtimeID)).rejects.toThrow("storage owner")
          await expect(Leases.observe(known, grant, 0)).rejects.toThrow("storage owner")
          await expect(
            Leases.settle(known, {
              kind: "closed",
              grantID: grant.grantID,
              generation: 1,
              reason: "control_closed",
              inspectedAt: Date.now(),
            }),
          ).rejects.toThrow("storage owner")
        })
      await Storage.provide({ store: foreign, artifactDirectory: path.join(f.root, "foreign-artifacts") }, async () => {
        expect(await Storage.query({ prefix: ["organization-execution-leases"], limit: 1 })).toEqual([])
      })
      const next = await Leases.begin(proof)
      expect(next.entryID).not.toBe(known.entryID)
      expect(next.hint).toBeUndefined()
      const another = await Leases.begin(proof)
      expect(another.entryID).not.toBe(next.entryID)
      expect(another.uncertainUntil).toBe(proof.expiresAt)
      await Leases.confirm(another, grant)
      await Leases.confirm(next, grant)
      const session = await Session.get(f.sessionID)
      await ScopeContext.provide({
        scope: session.scope,
        workspace: null,
        fn: async () => {
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), proof.rootID, "completed")
          const receipt = await f.connection.resources.release(
            Execution.ReleaseProof.parse({
              ...proof,
              purpose: "execution-resources-release",
              grantID: grant.grantID,
              generation: 1,
              outcome: "completed",
              materialized: true,
            }),
          )
          for (const changed of [
            { ...receipt, generation: 2 },
            { ...receipt, rootID: "foreign-root" },
            { ...receipt, sessionID: "foreign-session" },
          ])
            await expect(Leases.settle(known, { kind: "terminal", receipt: changed })).rejects.toThrow(
              "another generation",
            )
          expect(new Set((await Leases.page(grant.runtimeID)).items.map((item) => item.entryID))).toEqual(
            new Set([originalProbe.entryID, known.entryID]),
          )
          expect(await Leases.settle(known, { kind: "terminal", receipt })).toMatchObject({
            state: "settled",
            settlement: { kind: "terminal", receipt },
          })
          expect(await Leases.settle(known, { kind: "terminal", receipt })).toMatchObject({ state: "settled" })
          const inspected = await f.connection.resources.inspectRetention(
            Execution.InspectionProof.parse({
              ...(await f.description()),
              purpose: "execution-retention-inspection",
              rootID: proof.rootID,
            }),
          )
          if (inspected.state !== "known") throw new Error("Expected the original canonical grant")
          await Leases.observe(originalProbe, inspected.grant, inspected.inspectedAt)
          expect((await Leases.page(grant.runtimeID)).items).toEqual([])
        },
      })
    })
  } finally {
    await foreign.close()
  }
}, 15000)

test("pending cleanup pages retain every native root while root events address only their exact partition", async () => {
  await using f = await executionFixture({ execution: true })
  const first = await f.description()
  const permit = first.receipt.accepted!.permit
  const roots = [first.receipt.accepted!.effect.messageID]
  for (let index = 0; index < 17; index++) {
    const result = (
      await f.client.orgCommands.input(
        {
          sessionID: f.sessionID,
          orgCommandInputRequest: {
            schemaVersion: 1,
            orgID: permit.orgID,
            projectID: permit.projectID,
            runtimeID: permit.runtimeID,
            sessionID: f.sessionID,
            requestID: `queued-cleanup-${index}`,
            input: {
              operation: "input",
              mode: "task",
              parts: [{ type: "text", text: "Keep this distinct queued root" }],
            },
          },
        },
        { headers: f.headers, throwOnError: true },
      )
    ).data
    roots.push(result.effect.messageID)
  }
  await f.runtime.run(async () => {
    const entries: Leases.Entry[] = []
    let after: string | undefined
    do {
      const page = await Leases.page(permit.runtimeID, { after, limit: 7 })
      expect(page.items.length).toBeLessThanOrEqual(7)
      entries.push(...page.items)
      after = page.cursor
    } while (after)
    expect(entries).toHaveLength(18)
    expect(new Set(entries.map((entry) => entry.authority.rootID))).toEqual(new Set(roots))
    const selected = await Leases.page(permit.runtimeID, {
      target: { sessionID: f.sessionID, rootID: roots[15]! },
      limit: 7,
    })
    expect(selected.items.map((entry) => entry.authority.rootID)).toEqual([roots[15]!])
    expect(
      (await Leases.page(permit.runtimeID, { target: { sessionID: "foreign-session", rootID: roots[15]! } })).items,
    ).toEqual([])
  })
}, 15000)

for (const partition of ["runtime", "root"] as const)
  test(`a ${partition} pending cleanup page stays coherent across a real terminal settlement and rejects a retained corrupt marker`, async () => {
    await using f = await executionFixture({ execution: true })
    const proof = await f.binding()
    const grant = await f.connection.resources.bind(proof)
    await f.runtime.run(async () => {
      const originalRuntime = RuntimeContext.current()
      const originalStore = Storage.current().store
      const known = await Leases.confirm(await Leases.begin(proof), grant)
      const session = await Session.get(f.sessionID)
      await ScopeContext.provide({
        scope: session.scope,
        workspace: null,
        fn: async () => {
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), proof.rootID, "completed")
          const receipt = await f.connection.resources.release(
            Execution.ReleaseProof.parse({
              ...proof,
              purpose: "execution-resources-release",
              grantID: grant.grantID,
              generation: 1,
              outcome: "completed",
              materialized: true,
            }),
          )
          const input = {
            limit: 64,
            ...(partition === "root" ? { target: { sessionID: f.sessionID, rootID: proof.rootID } } : {}),
          }
          const before = await Leases.page(grant.runtimeID, input)
          expect(before.items).toContainEqual(known)
          const prefix = [
            "organization-execution-leases",
            ...(partition === "root"
              ? ["pending-root", grant.runtimeID, f.sessionID, proof.rootID]
              : ["pending", grant.runtimeID]),
          ]
          const selected = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const held: { marker?: { key: string[]; value: unknown } } = {}
          let holding = true
          const query = Storage.query
          using queries = spyOn(Storage, "query").mockImplementation(async <T>(value: Parameters<typeof query>[0]) => {
            const rows = await query<T>(value)
            if (
              !holding ||
              RuntimeContext.current() !== originalRuntime ||
              Storage.current().store !== originalStore ||
              JSON.stringify(value.prefix) !== JSON.stringify(prefix)
            )
              return rows
            const found = rows.find((row) => row.key.at(-1) === known.entryID)
            if (!found) return rows
            holding = false
            held.marker = { key: [...found.key], value: found.value }
            selected.resolve()
            await release.promise
            return rows
          })
          const reading = Leases.page(grant.runtimeID, input).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          try {
            await selected.promise
            expect(await Leases.settle(known, { kind: "terminal", receipt })).toMatchObject({
              state: "settled",
              settlement: { kind: "terminal", receipt },
            })
          } finally {
            release.resolve()
            await reading
          }
          const observed = await reading
          if (!observed.ok) throw observed.error
          const stable = before.items.filter((entry) => entry.entryID !== known.entryID)
          expect(observed.value.items.filter((entry) => entry.entryID !== known.entryID)).toEqual(stable)
          expect(observed.value.items.every((entry) => entry.state === "pending")).toBe(true)
          const concurrent = observed.value.items.find((entry) => entry.entryID === known.entryID)
          if (concurrent) expect(concurrent).toEqual(known)
          expect(observed.value.cursor).toBe(before.cursor)
          expect((await Leases.page(grant.runtimeID, input)).items).toEqual(stable)
          const marker = held.marker
          if (!marker) throw new Error("The original pending marker was not observed")
          await Storage.write(marker.key, marker.value)
          try {
            const corrupt = await Leases.page(grant.runtimeID, input).then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            )
            if (corrupt.ok) throw new Error("A settled canonical entry cannot retain its pending marker")
            if (!(corrupt.error instanceof OrganizationRuntimeError)) throw corrupt.error
            expect(corrupt.error.data).toEqual({
              code: "PROTOCOL_MISMATCH",
              message: "Native cleanup pending index is inconsistent",
              outcome: "rejected",
              retryable: false,
            })
          } finally {
            await Storage.remove(marker.key)
          }
        },
      })
    })
  }, 15_000)
