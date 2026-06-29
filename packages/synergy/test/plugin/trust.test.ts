import { describe, expect, test } from "bun:test"
import { approvedPluginTrustDecision } from "../../src/plugin/trust"
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
