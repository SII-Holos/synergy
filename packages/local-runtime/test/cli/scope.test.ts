import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { withScopeContext, withScopeRuntime } from "../../src/cli/scope"
import { testRuntime } from "../support/runtime"

test("explicit CLI contexts retain their Scope without registering the launch directory", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using project = await tmpdir()
    await using launch = await tmpdir()
    const scope = await project.scope()
    const selected = await withScopeContext(
      launch.path,
      async () => {
        await Promise.resolve()
        return ScopeContext.current.scope.id
      },
      scope.id,
    )
    expect(selected).toBe(scope.id)
    expect(ScopeContext.tryScope()).toBeUndefined()
    let called = false
    await expect(
      withScopeContext(
        launch.path,
        async () => {
          called = true
        },
        "missing-scope",
      ),
    ).rejects.toThrow("Scope not found: missing-scope")
    expect(called).toBe(false)
    expect((await Scope.list()).some((entry) => entry.local?.directory === launch.path)).toBe(false)
  })
})

test("CLI runtime callbacks release Scope resources after both rejection and success", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using fixture = await tmpdir()
    let opened = 0
    let closed = 0
    const resource = ScopedState.create(
      () => ++opened,
      async () => {
        closed++
      },
    )
    const failure = new Error("callback failed")
    await expect(
      withScopeRuntime(fixture.path, async () => {
        expect(resource()).toBe(1)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(closed).toBe(1)
    expect(await withScopeRuntime(fixture.path, async () => resource())).toBe(2)
    expect(closed).toBe(2)
    expect(ScopeContext.tryScope()).toBeUndefined()
  })
})
