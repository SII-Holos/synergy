import { describe, expect, test } from "bun:test"
import {
  formatPluginBuildId,
  presentPluginFeature,
  presentPluginPermission,
} from "../../src/plugin/permission-presentation"

describe("plugin permission presentation", () => {
  test("localizes generated feature counts and preserves authored feature copy", () => {
    const translate = (copy: { id?: string; values?: Record<string, unknown> }) =>
      `${copy.id}:${copy.values?.count ?? ""}`
    expect(
      presentPluginFeature(
        { key: "agents", title: "Specialized agents", description: "Provides 3 specialized agents." },
        translate,
      ).description,
    ).toBe("app.plugin.feature.agents.description:3")
    expect(
      presentPluginFeature(
        { key: "agents", title: "Specialized agents", description: "Agents for your research workflows." },
        translate,
      ).description,
    ).toBe("Agents for your research workflows.")
  })
  test("localizes generated host access while preserving authored descriptions", () => {
    const translate = (copy: { id?: string; message?: string }) => `localized:${copy.id}`
    expect(
      presentPluginPermission(
        {
          key: "session.read",
          title: "Session read",
          description: "Can use the declared Synergy access session.read.",
        },
        translate,
      ).title,
    ).toBe("localized:app.plugin.permission.sessionRead")
    expect(
      presentPluginPermission(
        {
          key: "session.read",
          title: "Read selected conversations",
          description: "Read conversations selected for this plugin.",
        },
        translate,
      ).title,
    ).toBe("Read selected conversations")
    expect(
      presentPluginPermission({ key: "settings.read", title: "settings.read", technical: "settings.read" }, translate),
    ).toEqual({ title: "localized:app.plugin.permission.settingsRead", technical: "settings.read" })
  })
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
