import { describe, expect, test } from "bun:test"
import path from "node:path"
import { resolveAppStaticRequest } from "../../src/server/app-static"
import { tmpdir } from "../fixture/fixture"

describe("Web app static routing", () => {
  test("serves existing deep-route assets but never falls missing assets through to the SPA", async () => {
    await using tmp = await tmpdir()
    const asset = path.join(tmp.path, "assets", "panel.js")
    await Bun.write(asset, "export {}")

    expect(await resolveAppStaticRequest(tmp.path, "/home/session/assets/panel.js")).toEqual({
      type: "file",
      path: asset,
      immutable: true,
    })
    expect(await resolveAppStaticRequest(tmp.path, "/home/session/assets/missing.js")).toEqual({
      type: "missing",
    })
    expect(await resolveAppStaticRequest(tmp.path, "/favicon-missing.svg")).toEqual({
      type: "missing",
    })
    expect(await resolveAppStaticRequest(tmp.path, "/home/session/session-1")).toEqual({
      type: "spa",
    })
  })
})
