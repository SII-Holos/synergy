import { describe, expect, test } from "bun:test"
import { providerCatalogPresentation } from "../../../src/components/provider/provider-catalog-presentation"

describe("provider model catalog presentation", () => {
  test("verified and cached lists are routine information", () => {
    for (const source of ["live", "cached"] as const) {
      const result = providerCatalogPresentation({ source, refreshing: false, modelCount: 8, lastVerifiedAt: 123 })
      expect(result.tone).toBe("neutral")
      expect(result.status).toBe(source === "live" ? "updated" : "cached")
      expect(result.verifiedAt).toBe(123)
    }
  })

  test("a successful HTTP response with a catalog failure still needs retry", () => {
    const result = providerCatalogPresentation({
      source: "live",
      refreshing: false,
      modelCount: 8,
      lastVerifiedAt: 123,
      failure: "network",
    })
    expect(result.status).toBe("failed")
    expect(result.tone).toBe("warning")
    expect(result.verifiedAt).toBe(123)
  })

  test("refreshing keeps the existing list without presenting the previous failure", () => {
    expect(
      providerCatalogPresentation({ source: "cached", refreshing: true, modelCount: 8, failure: "timeout" }),
    ).toMatchObject({ status: "loading", tone: "neutral" })
  })

  test("bundled lists and providers without live discovery do not manufacture verification", () => {
    expect(providerCatalogPresentation({ source: "bundled", refreshing: false, modelCount: 5 })).toMatchObject({
      status: "bundled",
      tone: "neutral",
      verifiedAt: undefined,
    })
    expect(providerCatalogPresentation()).toMatchObject({ status: "unavailable", tone: "neutral" })
  })
})
