import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { Scope } from "../../src/scope"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Scope.fromDirectory event emission", () => {
  test("repeated lookups of an unchanged directory emit only one scope.updated", async () => {
    await using tmp = await tmpdir()
    const events: unknown[] = []
    const handler = (event: { payload?: { type?: string } }) => {
      if (event.payload?.type === "scope.updated") events.push(event)
    }
    GlobalBus.on("event", handler)
    try {
      await Scope.fromDirectory(tmp.path)
      await Scope.fromDirectory(tmp.path)
      await Scope.fromDirectory(tmp.path)
    } finally {
      GlobalBus.off("event", handler)
    }
    expect(events).toHaveLength(1)
  })

  test("a changed scope record still emits exactly once per change", async () => {
    await using tmp = await tmpdir()
    const events: unknown[] = []
    const handler = (event: { payload?: { type?: string } }) => {
      if (event.payload?.type === "scope.updated") events.push(event)
    }
    GlobalBus.on("event", handler)
    try {
      await Scope.fromDirectory(tmp.path)
      // git init changes the record's vcs field; the ID stays stable because
      // an empty repo has no root commit to derive from.
      await $`git init`.cwd(tmp.path).quiet()
      await Scope.fromDirectory(tmp.path)
      await Scope.fromDirectory(tmp.path)
    } finally {
      GlobalBus.off("event", handler)
    }
    expect(events).toHaveLength(2)
  })
})
