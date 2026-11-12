import { expect, spyOn, test } from "bun:test"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { createCommandIntake } from "../src/command-intake"
import { startExecutionReleaseObserver } from "../src/release-observer"
import { registerSessionSchema } from "../src/session-schema"
import { registerMemberExecution, withMemberExecution } from "../src/execution-source"
import { OrganizationExecutionLeases as NativeLeases } from "../src/execution-leases"
import { OrganizationIntakePath as OriginalKeys } from "../src/storage/path"
import { executionFixture } from "./support/execution"

test("automatic terminal release follows a reacquired generation without rewriting original reception", async () => {
  await using f = await executionFixture({ execution: true })
  const proof = await f.binding()
  const first = await f.connection.resources.bind(proof)
  const observed = Promise.withResolvers<Execution.ReleaseReceipt>()
  f.interceptHTTP(async (request) => {
    if (!new URL(request.url).pathname.endsWith("/execution/release")) return
    const response = await f.service.fetch(request)
    if (response.ok) observed.resolve(Execution.ReleaseReceipt.parse(await response.clone().json()))
    return response
  })
  await f.runtime.run(async () => {
    const connection = f.connection.connected
    const controller = new AbortController()
    const intake = createCommandIntake({
      identity: connection.signingIdentity,
      runtimeID: connection.runtimeID,
      accountID: f.identity.accountID,
      connectionEpoch: connection.connectionEpoch,
      signal: controller.signal,
    })
    const session = await Session.get(f.sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const reconciled = Promise.withResolvers<void>()
        const write = Storage.write
        const settlement = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          await write(key, value)
          if (
            key[2] === "releases" &&
            value !== null &&
            typeof value === "object" &&
            "state" in value &&
            value.state === "released"
          )
            Storage.afterCommit(() => reconciled.resolve())
        })
        const close = startExecutionReleaseObserver({
          connection,
          intake,
          resources: f.connection.resources,
          signal: controller.signal,
        })
        try {
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), first.rootID, "completed")
          expect(await observed.promise).toMatchObject({ grantID: first.grantID, generation: 1 })
          await reconciled.promise
        } finally {
          await close()
          settlement.mockRestore()
        }
        expect(await intake.releaseEntries()).toEqual([])
        const originalKey = OriginalKeys.release(
          f.identity.orgID,
          proof.receipt.accepted!.permit.actor.subjectID,
          proof.receipt.accepted!.permit.requestID,
        )
        const original = await Storage.read(originalKey)
        await RolloutLedger.continueRun(RolloutLifecycle.owner(session), first.rootID)
        const second = await withMemberExecution(
          f.member.identity,
          { sessionID: f.sessionID },
          async ({ source, proof }, signal) => source.resources.bind(proof, signal),
        )
        expect(second).toMatchObject({
          grantID: first.grantID,
          rootID: first.rootID,
          retention: { state: "held", generation: 2 },
        })
        const completed = Promise.withResolvers<void>()
        const settledAgain = Promise.withResolvers<void>()
        const markAgain = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          await write(key, value)
          if (
            key[0] === "organization-execution-leases" &&
            key[1] === "entries" &&
            value !== null &&
            typeof value === "object" &&
            "state" in value &&
            value.state === "settled" &&
            "settlement" in value &&
            value.settlement !== null &&
            typeof value.settlement === "object" &&
            "kind" in value.settlement &&
            value.settlement.kind === "terminal" &&
            "hint" in value &&
            value.hint !== null &&
            typeof value.hint === "object" &&
            "generation" in value.hint &&
            value.hint.generation === 2
          )
            Storage.afterCommit(() => settledAgain.resolve())
        })
        const closeRenewed = startExecutionReleaseObserver({
          connection,
          intake,
          resources: f.connection.resources,
          signal: controller.signal,
        })
        const unsubscribe = Bus.subscribeGlobal(RolloutEvents.Updated, (event) => {
          const record = event.properties.record
          if (record.kind === "run" && record.value.id === first.rootID && record.value.status === "completed")
            completed.resolve()
        })
        try {
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), first.rootID, "completed")
          await completed.promise
          const deadline = setTimeout(
            () => settledAgain.reject(new Error("Renewed native generation did not settle")),
            4000,
          )
          try {
            await settledAgain.promise
          } finally {
            clearTimeout(deadline)
          }
        } finally {
          unsubscribe()
          await closeRenewed()
          markAgain.mockRestore()
        }
        expect(
          await f.connection.resources.retention(
            await intake.retentionProof({
              subjectID: proof.receipt.accepted!.permit.actor.subjectID,
              requestID: proof.receipt.accepted!.permit.requestID,
            }),
          ),
        ).toMatchObject({ grantID: first.grantID, retention: { state: "released", generation: 2 } })
        expect(await Storage.read(originalKey)).toEqual(original)
      },
    })
  })
}, 15_000)

test("lost renewed bind reply cannot be mistaken for an older pending terminal receipt", async () => {
  await using f = await executionFixture({ execution: true, proofLifetimeMs: 500 })
  const initial = await f.binding()
  await f.runtime.run(async () => {
    const connection = f.connection.connected
    const controller = new AbortController()
    const intake = createCommandIntake({
      identity: connection.signingIdentity,
      runtimeID: connection.runtimeID,
      accountID: f.identity.accountID,
      connectionEpoch: connection.connectionEpoch,
      signal: controller.signal,
    })
    const session = await Session.get(f.sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const first = await withMemberExecution(
          f.member.identity,
          { sessionID: f.sessionID },
          ({ source, proof }, signal) => source.resources.bind(proof, signal),
        )
        await RolloutLedger.finishRun(RolloutLifecycle.owner(session), initial.rootID, "completed")
        const prior = await f.connection.resources.release(
          Execution.ReleaseProof.parse({
            ...initial,
            purpose: "execution-resources-release",
            grantID: first.grantID,
            generation: 1,
            outcome: "completed",
            materialized: true,
          }),
        )
        expect(await intake.releaseEntries()).toHaveLength(1)
        await RolloutLedger.continueRun(RolloutLifecycle.owner(session), initial.rootID)
        let lost = false
        f.interceptHTTP(async (request) => {
          if (!new URL(request.url).pathname.endsWith("/execution/bind") || lost) return
          lost = true
          const response = await f.service.fetch(request)
          expect(response.ok).toBe(true)
          return Response.json(
            {
              code: "SERVICE_UNAVAILABLE",
              message: "Lost renewed bind response after service commit",
              outcome: "unknown",
              retryable: true,
            },
            { status: 503 },
          )
        })
        await expect(
          withMemberExecution(f.member.identity, { sessionID: f.sessionID }, ({ source, proof }, signal) =>
            source.resources.bind(proof, signal),
          ),
        ).rejects.toThrow("Lost renewed bind response")
        expect(await f.connection.resources.retention(await f.description())).toMatchObject({
          grantID: first.grantID,
          retention: { state: "held", generation: 2 },
        })
        const committed = Promise.withResolvers<void>()
        const originalCommitted = Promise.withResolvers<void>()
        const write = Storage.write
        const settled = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          await write(key, value)
          if (
            key[2] === "releases" &&
            typeof value === "object" &&
            value !== null &&
            "state" in value &&
            value.state === "released"
          )
            Storage.afterCommit(() => originalCommitted.resolve())
          const row = NativeLeases.Entry.safeParse(value)
          if (
            key[0] === "organization-execution-leases" &&
            key[1] === "entries" &&
            row.success &&
            row.data.state === "settled" &&
            row.data.settlement?.kind === "terminal" &&
            row.data.hint?.generation === 2
          )
            Storage.afterCommit(() => committed.resolve())
        })
        const close = startExecutionReleaseObserver({
          connection,
          intake,
          resources: f.connection.resources,
          signal: controller.signal,
        })
        try {
          const originalTimeout = setTimeout(
            () => originalCommitted.reject(new Error("Older terminal receipt did not reconcile")),
            3000,
          )
          try {
            await originalCommitted.promise
          } finally {
            clearTimeout(originalTimeout)
          }
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), initial.rootID, "completed")
          const timeout = setTimeout(
            () => committed.reject(new Error("Unknown renewed generation stayed retained")),
            3000,
          )
          try {
            await committed.promise
          } finally {
            clearTimeout(timeout)
          }
        } finally {
          await close()
          settled.mockRestore()
        }
        expect(await f.connection.resources.retention(await f.description())).toMatchObject({
          retention: { state: "released", generation: 2 },
        })
        const original = await Storage.read(
          OriginalKeys.release(
            f.identity.orgID,
            initial.receipt.accepted!.permit.actor.subjectID,
            initial.receipt.accepted!.permit.requestID,
          ),
        )
        expect(original).toMatchObject({ state: "released", receipt: prior })
      },
    })
  })
}, 15000)

function settledGeneration(runtimeID: string, generation: number, dispatchID?: string) {
  let terminal = false
  let dispatch = dispatchID === undefined
  const committed = Promise.withResolvers<void>()
  const write = Storage.write
  const settled = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    await write(key, value)
    const row = NativeLeases.Entry.safeParse(value)
    if (
      key[0] === "organization-execution-leases" &&
      key[1] === "entries" &&
      row.success &&
      row.data.authority.runtimeID === runtimeID &&
      row.data.state === "settled"
    )
      Storage.afterCommit(() => {
        terminal ||= row.data.settlement?.kind === "terminal" && row.data.hint?.generation === generation
        dispatch ||= row.data.entryID === dispatchID
        if (terminal && dispatch) committed.resolve()
      })
  })
  return {
    async wait() {
      const timeout = setTimeout(
        () => committed.reject(new Error("Native cleanup did not commit the exact terminal generation")),
        3000,
      )
      try {
        await committed.promise
      } finally {
        clearTimeout(timeout)
      }
    },
    close() {
      settled.mockRestore()
    },
  }
}

test("a lost provisional describe reply is reconciled without binding or replaying the root", async () => {
  await using f = await executionFixture({ execution: true, proofLifetimeMs: 500 })
  const binding = await f.binding()
  let describes = 0
  let binds = 0
  f.interceptHTTP(async (request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/execution/bind")) binds++
    if (!url.pathname.endsWith("/execution/resources")) return
    describes++
    const response = await f.service.fetch(request)
    expect(response.ok).toBe(true)
    return Response.json(
      { code: "SERVICE_UNAVAILABLE", message: "Lost describe commit response", outcome: "unknown", retryable: true },
      { status: 503 },
    )
  })
  await f.runtime.run(async () => {
    await expect(
      withMemberExecution(f.member.identity, { sessionID: f.sessionID }, ({ source, proof }, signal) =>
        source.resources.bind(proof, signal),
      ),
    ).rejects.toThrow("Lost describe commit response")
    const connection = f.connection.connected
    const controller = new AbortController()
    const intake = createCommandIntake({
      identity: connection.signingIdentity,
      runtimeID: connection.runtimeID,
      accountID: f.identity.accountID,
      connectionEpoch: connection.connectionEpoch,
      signal: controller.signal,
    })
    const session = await Session.get(f.sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const barrier = settledGeneration(connection.runtimeID, 0)
        const close = startExecutionReleaseObserver({
          connection,
          intake,
          resources: f.connection.resources,
          signal: controller.signal,
        })
        try {
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), binding.rootID, "completed")
          await barrier.wait()
        } finally {
          await close()
          barrier.close()
        }
        expect(await f.connection.resources.retention(await f.description())).toMatchObject({
          grantID: binding.receipt.accepted!.permit.provisionalGrantID,
          state: "closed",
        })
        expect(describes).toBe(1)
        expect(binds).toBe(0)
        expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), binding.rootID)).status).toBe("completed")
      },
    })
  })
}, 15000)

test("a fresh native Runtime migrates settled legacy receptions and closes an unrecorded renewed generation", async () => {
  await using f = await executionFixture()
  const proof = await f.binding()
  const first = await f.connection.resources.bind(proof)
  const connection = f.connection.connected
  const controller = new AbortController()
  const options = {
    identity: connection.signingIdentity,
    runtimeID: connection.runtimeID,
    accountID: f.identity.accountID,
    connectionEpoch: connection.connectionEpoch,
    signal: controller.signal,
  }
  let original: unknown
  const key = OriginalKeys.release(
    f.identity.orgID,
    proof.receipt.accepted!.permit.actor.subjectID,
    proof.receipt.accepted!.permit.requestID,
  )
  await f.runtime.run(async () => {
    const intake = createCommandIntake(options)
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
            grantID: first.grantID,
            generation: 1,
            outcome: "completed",
            materialized: true,
          }),
        )
        await intake.markRelease((await intake.releaseEntries())[0]!, receipt)
        original = await Storage.read(key)
        await RolloutLedger.continueRun(RolloutLifecycle.owner(session), proof.rootID)
        expect(
          await f.connection.resources.bind(
            await intake.bindingProof(
              {
                subjectID: proof.receipt.accepted!.permit.actor.subjectID,
                requestID: proof.receipt.accepted!.permit.requestID,
              },
              proof.rootID,
            ),
          ),
        ).toMatchObject({ retention: { state: "held", generation: 2 } })
        await RolloutLedger.finishRun(RolloutLifecycle.owner(session), proof.rootID, "completed")
      },
    })
  })
  await f.runtime.close()
  await using restarted = await testRuntime({
    home: f.runtime.host.home,
    register() {
      registerSessionSchema({ orgID: f.identity.orgID })
      registerMemberExecution(f.member.identity)
    },
  })
  await restarted.run(async () => {
    const intake = createCommandIntake(options)
    const session = await Session.get(f.sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const barrier = settledGeneration(connection.runtimeID, 2)
        const close = startExecutionReleaseObserver({
          connection,
          intake,
          resources: f.connection.resources,
          signal: controller.signal,
        })
        try {
          await barrier.wait()
        } finally {
          await close()
          barrier.close()
        }
        expect(await Storage.read(key)).toEqual(original)
        expect(
          await f.connection.resources.retention(
            await intake.retentionProof({
              subjectID: proof.receipt.accepted!.permit.actor.subjectID,
              requestID: proof.receipt.accepted!.permit.requestID,
            }),
          ),
        ).toMatchObject({ retention: { state: "released", generation: 2 } })
        expect((await NativeLeases.page(connection.runtimeID)).items).toEqual([])
      },
    })
  })
}, 15000)

test("closing waits for an accepted inspection and rejects its late cleanup writes", async () => {
  await using f = await executionFixture({ execution: true })
  const binding = await f.binding()
  await f.runtime.run(async () => {
    const connection = f.connection.connected
    const controller = new AbortController()
    const intake = createCommandIntake({
      identity: connection.signingIdentity,
      runtimeID: connection.runtimeID,
      accountID: f.identity.accountID,
      connectionEpoch: connection.connectionEpoch,
      signal: controller.signal,
    })
    const session = await Session.get(f.sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const grant = await withMemberExecution(
          f.member.identity,
          { sessionID: f.sessionID },
          ({ source, proof }, signal) => source.resources.bind(proof, signal),
        )
        await RolloutLedger.finishRun(RolloutLifecycle.owner(session), binding.rootID, "completed")
        const arrived = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const close = startExecutionReleaseObserver({
          connection,
          intake,
          signal: controller.signal,
          resources: {
            ...f.connection.resources,
            async inspectRetention(proof, signal) {
              const result = await f.connection.resources.inspectRetention(proof, signal)
              arrived.resolve()
              await resume.promise
              return result
            },
          },
        })
        await arrived.promise
        let stopped = false
        const closing = close().then(() => {
          stopped = true
        })
        await Promise.resolve()
        expect(stopped).toBe(false)
        resume.resolve()
        await closing
        expect(await f.connection.resources.retention(await f.description())).toMatchObject({
          retention: { state: "held", generation: 1 },
        })
        expect(
          (await NativeLeases.page(connection.runtimeID)).items.some(
            (entry) => entry.hint?.grantID === grant.grantID && entry.hint.generation === 1,
          ),
        ).toBe(true)
        const barrier = settledGeneration(connection.runtimeID, 1)
        const reopened = startExecutionReleaseObserver({
          connection,
          intake,
          resources: f.connection.resources,
          signal: controller.signal,
        })
        try {
          await barrier.wait()
        } finally {
          await reopened()
          barrier.close()
        }
        expect(await f.connection.resources.retention(await f.description())).toMatchObject({
          retention: { state: "released", generation: 1 },
        })
      },
    })
  })
}, 15000)

test("an unknown delayed bind retains its own signed commit horizon before an older grant observation can settle it", async () => {
  await using f = await executionFixture({ execution: true, proofLifetimeMs: 1000 })
  const binding = await f.binding()
  const connection = f.connection.connected
  const controller = new AbortController()
  const intakeOptions = {
    identity: connection.signingIdentity,
    runtimeID: connection.runtimeID,
    accountID: f.identity.accountID,
    connectionEpoch: connection.connectionEpoch,
    signal: controller.signal,
  }
  const pending = await f.runtime.run(async () => {
    const session = await Session.get(f.sessionID)
    return ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const first = await withMemberExecution(
          f.member.identity,
          { sessionID: f.sessionID },
          ({ source, proof }, signal) => source.resources.bind(proof, signal),
        )
        await RolloutLedger.finishRun(RolloutLifecycle.owner(session), binding.rootID, "completed")
        await f.connection.resources.release(
          Execution.ReleaseProof.parse({
            ...binding,
            purpose: "execution-resources-release",
            grantID: first.grantID,
            generation: 1,
            outcome: "completed",
            materialized: true,
          }),
        )
        await RolloutLedger.continueRun(RolloutLifecycle.owner(session), binding.rootID)
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const delivered = Promise.withResolvers<Response>()
        const verify = Execution.verifyBinding
        const verification = spyOn(Execution, "verifyBinding").mockImplementationOnce(async (...args) => {
          const valid = await verify(...args)
          entered.resolve()
          await resume.promise
          return valid
        })
        let expiresAt: number | undefined
        let dispatchID: string | undefined
        f.interceptHTTP(async (request) => {
          if (!new URL(request.url).pathname.endsWith("/execution/bind")) return
          expiresAt = Execution.BindingRequest.parse(await request.clone().json()).proof.expiresAt
          void f.service.fetch(request).then(delivered.resolve, delivered.reject)
          return Response.json(
            {
              code: "SERVICE_UNAVAILABLE",
              message: "The native caller lost its still-running bind",
              outcome: "unknown",
              retryable: true,
            },
            { status: 503 },
          )
        })
        try {
          await expect(
            withMemberExecution(f.member.identity, { sessionID: f.sessionID }, ({ source, proof }, signal) =>
              source.resources.bind(proof, signal),
            ),
          ).rejects.toThrow("still-running bind")
          await entered.promise
          const unknown = (await NativeLeases.page(connection.runtimeID)).items.filter(
            (entry) => entry.uncertainUntil !== undefined,
          )
          expect(unknown).toHaveLength(1)
          dispatchID = unknown[0]!.entryID
          expect(unknown[0]!.uncertainUntil).toBe(expiresAt)
          const inspected = await f.connection.resources.inspectRetention(
            await createCommandIntake(intakeOptions).cleanupProof(unknown[0]!.authority),
          )
          if (inspected.state !== "known") throw new Error("Expected the original canonical grant")
          expect(inspected.grant).toMatchObject({ retention: { state: "released", generation: 1 } })
          await expect(NativeLeases.observe(unknown[0]!, inspected.grant, inspected.inspectedAt)).rejects.toThrow(
            "may still commit",
          )
          resume.resolve()
          expect(Execution.BoundGrant.parse(await (await delivered.promise).json())).toMatchObject({
            retention: { state: "held", generation: 2 },
          })
        } finally {
          resume.resolve()
          verification.mockRestore()
          f.interceptHTTP(undefined)
        }
        if (!dispatchID || expiresAt === undefined) throw new Error("Missing original uncertain native dispatch")
        await RolloutLedger.finishRun(RolloutLifecycle.owner(session), binding.rootID, "completed")
        return { dispatchID, expiresAt }
      },
    })
  })
  await f.runtime.close()
  await using restarted = await testRuntime({
    home: f.runtime.host.home,
    register() {
      registerSessionSchema({ orgID: f.identity.orgID })
      registerMemberExecution(f.member.identity)
    },
  })
  await restarted.run(async () => {
    const intake = createCommandIntake(intakeOptions)
    const stored = (await NativeLeases.page(connection.runtimeID)).items.find(
      (entry) => entry.entryID === pending.dispatchID,
    )
    expect(stored).toMatchObject({ state: "pending", uncertainUntil: pending.expiresAt })
    const barrier = settledGeneration(connection.runtimeID, 2, pending.dispatchID)
    const close = startExecutionReleaseObserver({
      connection,
      intake,
      resources: f.connection.resources,
      signal: controller.signal,
    })
    try {
      await barrier.wait()
    } finally {
      await close()
      barrier.close()
    }
    expect(
      await f.connection.resources.retention(
        await intake.retentionProof({
          subjectID: binding.receipt.accepted!.permit.actor.subjectID,
          requestID: binding.receipt.accepted!.permit.requestID,
        }),
      ),
    ).toMatchObject({ retention: { state: "released", generation: 2 } })
    expect((await NativeLeases.page(connection.runtimeID)).items).toEqual([])
  })
}, 15000)

test("an unresolved native cleanup index failure survives observer shutdown", async () => {
  await using f = await executionFixture({ execution: true })
  await f.runtime.run(async () => {
    const connection = f.connection.connected
    const controller = new AbortController()
    const intake = createCommandIntake({
      identity: connection.signingIdentity,
      runtimeID: connection.runtimeID,
      accountID: f.identity.accountID,
      connectionEpoch: connection.connectionEpoch,
      signal: controller.signal,
    })
    await Storage.write(["organization-execution-leases", "pending", connection.runtimeID, "corrupt-index-entry"], {
      version: 99,
    })
    const retried = Promise.withResolvers<void>()
    const query = Storage.query
    let scans = 0
    const observe = spyOn(Storage, "query").mockImplementation(
      async <T>(input: Parameters<typeof Storage.query>[0]) => {
        const rows = await query<T>(input)
        if (input.prefix?.[0] === "organization-execution-leases" && input.prefix[1] === "pending" && ++scans === 2)
          retried.resolve()
        return rows
      },
    )
    const close = startExecutionReleaseObserver({
      connection,
      intake,
      resources: f.connection.resources,
      signal: controller.signal,
    })
    const timeout = setTimeout(
      () => retried.reject(new Error("Native failed index was not retained for reconciliation")),
      3000,
    )
    try {
      await retried.promise
      await expect(close()).rejects.toThrow("cleanup index")
    } finally {
      clearTimeout(timeout)
      await close().catch(() => {})
      observe.mockRestore()
    }
  })
}, 15000)

test("unknown cleanup waits for the service inspection watermark even after its native timer expires", async () => {
  await using f = await executionFixture({ execution: true, proofLifetimeMs: 500 })
  const binding = await f.binding()
  f.interceptHTTP(async (request) => {
    if (!new URL(request.url).pathname.endsWith("/execution/resources")) return
    const response = await f.service.fetch(request)
    expect(response.ok).toBe(true)
    return Response.json(
      { code: "SERVICE_UNAVAILABLE", message: "Unknown original description", outcome: "unknown", retryable: true },
      { status: 503 },
    )
  })
  await f.runtime.run(async () => {
    await expect(
      withMemberExecution(f.member.identity, { sessionID: f.sessionID }, ({ source, proof }, signal) =>
        source.resources.bind(proof, signal),
      ),
    ).rejects.toThrow("Unknown original description")
    const connection = f.connection.connected
    const controller = new AbortController()
    const intake = createCommandIntake({
      identity: connection.signingIdentity,
      runtimeID: connection.runtimeID,
      accountID: f.identity.accountID,
      connectionEpoch: connection.connectionEpoch,
      signal: controller.signal,
    })
    const unknown = (await NativeLeases.page(connection.runtimeID)).items.find(
      (entry) => entry.uncertainUntil !== undefined,
    )
    if (!unknown?.uncertainUntil) throw new Error("Missing the exact dispatched expiry")
    const signedExpiry = unknown.uncertainUntil
    const behind = Promise.withResolvers<void>()
    const observe = NativeLeases.observe
    const verified = spyOn(NativeLeases, "observe").mockImplementation(async (...args) => {
      try {
        return await observe(...args)
      } finally {
        if (args[0].entryID === unknown.entryID && args[2] === signedExpiry - 1) behind.resolve()
      }
    })
    f.interceptHTTP(async (request) => {
      if (!new URL(request.url).pathname.endsWith("/execution/retention")) return
      const response = await f.service.fetch(request)
      if (!response.ok) return response
      const result = Execution.Inspection.parse(await response.json())
      return Response.json({ ...result, inspectedAt: signedExpiry - 1 })
    })
    const session = await Session.get(f.sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const barrier = settledGeneration(connection.runtimeID, 0, unknown.entryID)
        const close = startExecutionReleaseObserver({
          connection,
          intake,
          resources: f.connection.resources,
          signal: controller.signal,
        })
        const timeout = setTimeout(
          () => behind.reject(new Error("Unknown intent did not reach the service-clock boundary")),
          3000,
        )
        try {
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), binding.rootID, "completed")
          await behind.promise
          expect(
            (await NativeLeases.page(connection.runtimeID)).items.find((entry) => entry.entryID === unknown.entryID),
          ).toMatchObject({ state: "pending", uncertainUntil: signedExpiry })
          f.interceptHTTP(undefined)
          await barrier.wait()
          expect((await NativeLeases.page(connection.runtimeID)).items).toEqual([])
        } finally {
          clearTimeout(timeout)
          await close()
          barrier.close()
          verified.mockRestore()
          f.interceptHTTP(undefined)
        }
      },
    })
  })
}, 15000)
