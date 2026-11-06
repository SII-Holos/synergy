import { expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionWorkspaceRuntime } from "../../src/session/workspace-runtime"
import { WorkspaceAccess } from "../../src/workspace/access"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"

test.each(["explicit", "ambient"] as const)(
  "%s cancellation drains a queued Workspace binding selection",
  async (source) => {
    await using runtime = await testRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null })
          const destination = await WorkspaceCatalog.create({
            scopeID: "home",
            backend: { provider: "objects", spec: {} },
          })
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const submitted = Promise.withResolvers<void>()
          const holder = SessionWorkspaceRuntime.withBinding(session.id, async () => {
            entered.resolve()
            await release.promise
          })
          const abort = new AbortController()
          let selection: Promise<unknown> | undefined
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            await entered.promise
            const select = () => {
              submitted.resolve()
              return Session.updateWorkspace(session.id, null, {
                reference: { workspaceID: destination.id, workspaceGeneration: destination.binding.generation },
                ...(source === "explicit" ? { signal: abort.signal } : {}),
              })
            }
            selection = (
              source === "explicit"
                ? select()
                : WorkspaceAccess.task({ sessionID: session.id, workspace: null, signal: abort.signal }, select)
            ).then(
              () => "unexpected selection",
              (error: unknown) => error,
            )
            await submitted.promise
            abort.abort(new Error("cancelled selection"))
            expect(
              await Promise.race([
                selection,
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("Cancelled selection remained blocked on the binding lease")),
                    1000,
                  )
                }),
              ]),
            ).toMatchObject({ message: "cancelled selection" })
            expect((await Session.get(session.id)).workspaceID).toBeNull()
          } finally {
            clearTimeout(timeout)
            release.resolve()
            await holder
            await selection
          }
        },
      }),
    )
  },
)

test("cancellation after the transition hook rejects Workspace publication inside its editor", async () => {
  const abort = new AbortController()
  await using runtime = await testRuntime({
    register() {
      SessionWorkspaceRuntime.registerTransition("cancel-selection", async () => {
        abort.abort(new Error("cancelled before publication"))
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const destination = await WorkspaceCatalog.create({
          scopeID: "home",
          backend: { provider: "objects", spec: {} },
        })
        await expect(
          Session.updateWorkspace(session.id, null, {
            signal: abort.signal,
            reference: { workspaceID: destination.id, workspaceGeneration: destination.binding.generation },
          }),
        ).rejects.toThrow("cancelled before publication")
        expect((await Session.get(session.id)).workspaceID).toBeNull()
        expect(await SessionWorkspaceRuntime.withBinding(session.id, async () => "released")).toBe("released")
      },
    }),
  )
})
