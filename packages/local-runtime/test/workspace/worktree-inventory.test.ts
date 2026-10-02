import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "../../src/workspace/worktree"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("worktree inventory does not walk descendants and details remain independently readable", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(tmp.path).quiet()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const created = await Worktree.create({ name: "inventory", bind: false, baseRef: "current" })
        const nested = path.join(created.path, "large-descendant")
        await fs.mkdir(nested)
        await Bun.write(path.join(nested, "data"), "x".repeat(4096))
        const original = fs.readdir.bind(fs)
        let traversed = false
        {
          using read = spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
            if (path.resolve(String(args[0])) === path.resolve(nested)) {
              traversed = true
              throw new Error("descendant unavailable")
            }
            return original(...args)
          }) as typeof fs.readdir)
          const items = await Worktree.inventory()
          expect(items.some((item) => item.id === created.id)).toBe(true)
          expect(items.every((item) => !("dirty" in item) && !("diskBytes" in item))).toBe(true)
          expect(traversed).toBe(false)
        }
        const detail = await Worktree.details({ target: created.id })
        expect(detail.state).toBe("ready")
        expect(detail.dirty).toBe(true)
        expect(detail.diskBytes).toBeGreaterThanOrEqual(4096)
        expect(detail.cleanupEligible).toBe(false)
      },
    })
  }))
