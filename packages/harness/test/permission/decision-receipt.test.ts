import { expect, spyOn, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { PermissionRules } from "../../src/permission/rules"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const actor = (subjectID: string) => ({
  kind: "account" as const,
  orgID: "fixture-org",
  subjectID,
  displayName: subjectID,
  clientKind: "web" as const,
  requestID: `command-${subjectID}`,
})
const ask = (sessionID: string, id: string, signal?: AbortSignal) =>
  PermissionNext.ask({ id, sessionID, permission: "bash", patterns: ["fixture *"], metadata: {}, ruleset: [], signal })

test("the first permission decision keeps its actor across concurrent answers, lost acknowledgement and restart", async () => {
  await using directory = await tmpdir()
  let runtime = await testRuntime({ home: directory.path })
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const pending = ask("session-winner", "permission-winner")
          const results = await Promise.all([
            PermissionNext.decide({
              sessionID: "session-winner",
              requestID: "permission-winner",
              reply: "always",
              actor: actor("B"),
            }),
            PermissionNext.decide({
              sessionID: "session-winner",
              requestID: "permission-winner",
              reply: "once",
              actor: actor("C"),
            }),
          ])
          await pending
          expect(results.map((result) => result.status)).toEqual(["resolved", "already_resolved"])
          expect(results[0].receipt).toMatchObject({
            actor: actor("B"),
            outcome: { kind: "permission", reply: "always" },
          })

          expect(results[1].receipt).toEqual(results[0].receipt)
          expect(await PermissionRules.userRuleset()).toHaveLength(1)
          expect(
            (
              await PermissionNext.decide({
                sessionID: "session-winner",
                requestID: "permission-winner",
                reply: "reject",
                actor: actor("C"),
              })
            ).receipt,
          ).toEqual(results[0].receipt)
        },
      }),
    )
    await runtime.close()
    runtime = await testRuntime({ home: directory.path })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          expect(
            await PermissionNext.decide({
              sessionID: "session-winner",
              requestID: "permission-winner",
              reply: "once",
              actor: actor("C"),
            }),
          ).toMatchObject({ status: "already_resolved", receipt: { actor: actor("B") } })
          expect(
            await PermissionNext.decide({
              sessionID: "session-winner",
              requestID: "permission-old",
              reply: "always",
              actor: actor("C"),
            }),
          ).toEqual({ status: "expired" })
          expect(await PermissionRules.userRuleset()).toHaveLength(1)
          await expect(ask("session-winner", "permission-winner")).rejects.toThrow("already resolved")
        },
      }),
    )
  } finally {
    await runtime.close()
  }
})

test("an always rule and its winner receipt roll back together and keep the request pending", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const pending = ask("session-atomic", "permission-atomic")
        const write = Storage.write.bind(Storage)
        const failing = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          if (key.includes("decision_receipts")) throw new Error("fixture receipt unavailable")
          return write(key, value)
        })
        try {
          await expect(
            PermissionNext.decide({
              sessionID: "session-atomic",
              requestID: "permission-atomic",
              reply: "always",
              actor: actor("B"),
            }),
          ).rejects.toThrow("fixture receipt unavailable")
          expect(await PermissionRules.userRuleset()).toEqual([])
          expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission-atomic"])
        } finally {
          failing.mockRestore()
        }
        expect(
          await PermissionNext.decide({
            sessionID: "session-atomic",
            requestID: "permission-atomic",
            reply: "once",
            actor: actor("C"),
          }),
        ).toMatchObject({ status: "resolved", receipt: { actor: actor("C") } })
        await pending
        expect(await PermissionRules.userRuleset()).toEqual([])
      },
    }),
  )
})

test("an outer admission rollback cannot resolve a native promise or retain a permission decision", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const pending = ask("session-admission", "permission-admission")
        await expect(
          Storage.transaction(async () => {
            await PermissionNext.decide({
              sessionID: "session-admission",
              requestID: "permission-admission",
              reply: "always",
              actor: actor("B"),
            })
            throw new Error("fixture command receipt failed")
          }),
        ).rejects.toThrow("fixture command receipt failed")
        expect(await PermissionRules.userRuleset()).toEqual([])
        expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission-admission"])
        await PermissionNext.decide({
          sessionID: "session-admission",
          requestID: "permission-admission",
          reply: "once",
          actor: actor("C"),
        })
        await pending
      },
    }),
  )
})

test("a rejected winner atomically attributes the native same-session rejection cascade", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const pending = Promise.allSettled([
          ask("session-reject", "permission-first"),
          ask("session-reject", "permission-second"),
        ])
        await PermissionNext.decide({
          sessionID: "session-reject",
          requestID: "permission-first",
          reply: "reject",
          actor: actor("B"),
        })
        expect((await pending).map((result) => result.status)).toEqual(["rejected", "rejected"])
        expect(
          await PermissionNext.decide({
            sessionID: "session-reject",
            requestID: "permission-second",
            reply: "always",
            actor: actor("C"),
          }),
        ).toMatchObject({
          status: "already_resolved",
          receipt: {
            actor: actor("B"),
            outcome: { kind: "permission", reply: "reject", causedBy: "permission-first" },
          },
        })
        expect(await PermissionRules.userRuleset()).toEqual([])
      },
    }),
  )
})

test("a genuinely committed decision with a lost SQL acknowledgement reconciles the original pending caller", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const pending = ask("session-unknown", "permission-unknown")
        expect(await PermissionRules.userRuleset()).toEqual([])
        const store = Storage.current().store
        const transaction = store.transaction.bind(store)
        const lost = spyOn(store, "transaction").mockImplementationOnce(async (body, options) => {
          await transaction(body, options)
          throw new StorageCommitUnknownError(undefined, new Error("fixture lost SQL acknowledgement"))
        })
        try {
          await expect(
            PermissionNext.decide({
              sessionID: "session-unknown",
              requestID: "permission-unknown",
              reply: "always",
              actor: actor("B"),
            }),
          ).rejects.toBeInstanceOf(StorageCommitUnknownError)
          expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission-unknown"])
        } finally {
          lost.mockRestore()
        }
        expect(
          await PermissionNext.decide({
            sessionID: "session-unknown",
            requestID: "permission-unknown",
            reply: "reject",
            actor: actor("C"),
          }),
        ).toMatchObject({ status: "already_resolved", receipt: { actor: actor("B"), outcome: { reply: "always" } } })
        await pending
        expect(await PermissionNext.list()).toEqual([])
        expect(await PermissionRules.userRuleset()).toHaveLength(1)
      },
    }),
  )
})

test("cancellation at the actual commit guard cannot publish a rule or winner", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const controller = new AbortController()
        const pending = ask("session-final-guard", "permission-final-guard", controller.signal).catch(
          (error: unknown) => error,
        )
        const write = Storage.write.bind(Storage)
        const abort = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          const result = await write(key, value)
          if (key.includes("decision_receipts")) controller.abort()
          return result
        })
        try {
          await expect(
            PermissionNext.decide({
              sessionID: "session-final-guard",
              requestID: "permission-final-guard",
              reply: "always",
              actor: actor("B"),
            }),
          ).rejects.toThrow("expired before commit")
        } finally {
          abort.mockRestore()
        }
        expect(await pending).toBeInstanceOf(DOMException)
        expect(await PermissionRules.userRuleset()).toEqual([])
        expect(
          await PermissionNext.decide({
            sessionID: "session-final-guard",
            requestID: "permission-final-guard",
            reply: "once",
            actor: actor("C"),
          }),
        ).toEqual({ status: "expired" })
      },
    }),
  )
})
