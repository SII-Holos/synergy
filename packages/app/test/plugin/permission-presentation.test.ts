import { describe, expect, test } from "bun:test"
import { formatPluginBuildId, presentPluginPermission } from "../../src/plugin/permission-presentation"

describe("plugin permission presentation", () => {
  test("does not repeat a raw capability in its title, fallback description, and technical details", () => {
    expect(
      presentPluginPermission({
        key: "config:read",
        title: "config:read",
        description: "Requires config:read",
        technical: "config:read",
      }),
    ).toEqual({ title: "config:read" })

    expect(
      presentPluginPermission({
        key: "shell.execute",
        title: "shell.execute",
        description: "Synergy host capability shell.execute",
        technical: "shell.execute",
      }),
    ).toEqual({ title: "shell.execute" })
  })

  test("keeps meaningful user copy and exposes a different technical identifier", () => {
    expect(
      presentPluginPermission({
        key: "shell.execute",
        title: "Run declared commands",
        description: "Run commands declared by this plugin.",
        technical: "shell.execute",
      }),
    ).toEqual({
      title: "Run declared commands",
      description: "Run commands declared by this plugin.",
      technical: "shell.execute",
    })
  })
})

describe("plugin build presentation", () => {
  test("shows a short stable build identifier instead of presenting a hash as a generation number", () => {
    expect(formatPluginBuildId("2f6130c27995c94c1ec2f00ab930b6d5")).toBe("2f6130c2")
  })
})
