import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Worktree } from "../../src/project/worktree"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "../fixture/fixture"

describe("session input workspace availability", () => {
  test("rejects input before accepting it when the bound worktree was deleted externally", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Missing Worktree Input" })
        const worktree = await Worktree.create({
          sessionID: session.id,
          name: "missing-input",
          baseRef: "current",
          bind: true,
        })

        try {
          await $`git worktree remove --force ${worktree.path}`.cwd(scope.worktree).quiet()

          const response = await Server.App().request(
            `/session/${session.id}/input?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text: "Continue" }] }),
            },
          )

          expect(response.status).toBe(409)
          expect(await response.json()).toEqual({
            name: "WorktreeUnavailableError",
            data: {
              message: "The worktree for this session is no longer available.",
              reason: "missing",
            },
          })
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
          expect(SessionManager.isRunning(session.id)).toBe(false)
        } finally {
          await Bun.sleep(50)
          await Worktree.remove({ sessionID: session.id, target: worktree.id, force: true }).catch(() => undefined)
          await Session.remove(session.id)
        }
      },
    })
  })
})
