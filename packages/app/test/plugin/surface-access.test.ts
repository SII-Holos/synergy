import { expect, test } from "bun:test"
import { createPluginSurfaceAccess } from "../../src/plugin/surface-access"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"

test("resources acquired through a surface are released even when the author forgets cleanup", () => {
  const lifetime = createPluginSurfaceLifetime(() => {})
  const access = createPluginSurfaceAccess({
    lifetime: lifetime.context,
    capabilities: ["composer.write"],
    current: () => true,
  })
  let releases = 0
  const release = access.own("composer.write", () => () => {
    releases++
  })
  expect(releases).toBe(0)
  lifetime.dispose()
  release()
  expect(releases).toBe(1)
  expect(() =>
    access.own("composer.write", () => () => {
      releases++
    }),
  ).toThrow("disposed")
  expect(releases).toBe(1)
})

test("shell presentation does not confer draft, submit or session control authority", () => {
  const lifetime = createPluginSurfaceLifetime(() => {})
  const access = createPluginSurfaceAccess({
    lifetime: lifetime.context,
    capabilities: ["ui.shell", "composer.read"],
    current: () => true,
  })
  expect(() => access.require("composer.read")).not.toThrow()
  for (const capability of ["composer.write", "session.submit", "session.control"]) {
    expect(() => access.require(capability)).toThrow(capability)
  }
  lifetime.dispose()
  expect(() => access.require("composer.read")).toThrow("disposed")
})

test("bound calls reject late results after identity changes without stopping server-owned work", async () => {
  const lifetime = createPluginSurfaceLifetime(() => {})
  let current = true
  const access = createPluginSurfaceAccess({
    lifetime: lifetime.context,
    capabilities: ["session.submit"],
    current: () => current,
  })
  const pending = Promise.withResolvers<string>()
  let completed = false
  const result = access.run("session.submit", async () => {
    const value = await pending.promise
    completed = true
    return value
  })
  current = false
  pending.resolve("accepted")
  await expect(result).rejects.toThrow("identity")
  expect(completed).toBe(true)
  expect(() => access.require("session.submit")).toThrow("identity")
  lifetime.dispose()
})
