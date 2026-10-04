import { expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { ReviewState } from "../../src/review/state"
import { ReviewRoutes } from "../../src/review/routes"

test("review notes persist with revisions and cannot cross scope ownership", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using first = await tmpdir(),
      second = await tmpdir()
    let id = ""
    await ScopeContext.provide({
      scope: await first.scope(),
      fn: async () => {
        const session = await Session.create({})
        id = session.id
        const initial = await ReviewState.get(id)
        expect(initial.revision).toBe(0)
        const saved = await ReviewState.update({
          sessionID: id,
          revision: 0,
          state: { ...initial.state, viewed: { file: "version-one" } },
        })
        expect(saved.revision).toBe(1)
        expect((await ReviewState.get(id)).state.viewed.file).toBe("version-one")
        await expect(ReviewState.update({ sessionID: id, revision: 0, state: initial.state })).rejects.toMatchObject({
          name: "ReviewConflict",
        })
      },
    })
    await ScopeContext.provide({
      scope: await second.scope(),
      fn: async () => {
        await expect(ReviewState.get(id)).rejects.toThrow("scope")
      },
    })
  })
})

test("mounted review routes expose every required query and unique generated operation", async () => {
  const spec = await generateSpecs(new Hono().route("/review", ReviewRoutes()))
  const operation = spec.paths?.["/review/compare"]?.get
  expect(operation?.operationId).toBe("review.compare")
  expect(operation?.parameters?.map((parameter) => ("name" in parameter ? parameter.name : undefined))).toEqual(
    expect.arrayContaining(["source", "workspaceID", "generation", "from", "to"]),
  )
  expect(spec.paths?.["/review/file"]?.get?.operationId).toBe("review.file")
  expect(spec.paths?.["/review/state/{sessionID}"]?.put?.operationId).toBe("review.state.update")
})
