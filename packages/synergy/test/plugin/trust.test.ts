import path from "path"
import { describe, expect, test } from "bun:test"
import { approvedPluginTrustDecision, derivePluginSource } from "../../src/plugin/trust"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("approvedPluginTrustDecision", () => {
  test("keeps approved npm plugins sandboxed without verified integrity", () => {
    const trust = approvedPluginTrustDecision({ source: "npm" })

    expect(trust.source).toBe("npm")
    expect(trust.userTrusted).toBe(true)
    expect(trust.verifiedIntegrity).toBe(false)
    expect(trust.tier).toBe("sandbox")
  })

  test("trusts approved local and official plugins", () => {
    expect(approvedPluginTrustDecision({ source: "local" }).tier).toBe("trusted-import")
    expect(approvedPluginTrustDecision({ source: "official" }).tier).toBe("trusted-import")
  })

  test("never elevates URL-sourced plugins through approval alone", () => {
    const trust = approvedPluginTrustDecision({ source: "url", verifiedIntegrity: true })

    expect(trust.userTrusted).toBe(true)
    expect(trust.verifiedIntegrity).toBe(true)
    expect(trust.tier).toBe("sandbox")
  })
})

describe("derivePluginSource", () => {
  test("treats paths outside the Synergy cache as local", () => {
    expect(derivePluginSource("/tmp/workspace/plugin")).toBe("local")
  })

  test("treats local plugin archive cache entries as local", () => {
    const pluginDir = path.join(Global.Path.cache, "plugin-archives", "demo-plugin-0.1.0.synergy-plugin")

    expect(derivePluginSource(pluginDir)).toBe("local")
  })

  test("does not treat plugin-archives sibling prefixes as archive cache entries", () => {
    const pluginDir = path.join(Global.Path.cache, "plugin-archives-other", "demo-plugin")

    expect(derivePluginSource(pluginDir)).toBe("url")
  })

  test("does not guess npm when cached plugin source is unknown", () => {
    const pluginDir = path.join(Global.Path.cache, "node_modules", "demo-plugin")

    expect(derivePluginSource(pluginDir)).toBe("url")
  })
})
