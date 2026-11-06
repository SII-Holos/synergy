import { expect, test } from "bun:test"
import {
  compareProviderIDs,
  isRecommendedProvider,
  providerConnectCopy,
} from "../../../src/components/provider/provider-recommendation"

const profiles = {
  alpha: {
    id: "alpha",
    name: "Alpha",
    recommendation: {
      level: "recommended",
      rank: 20,
      headline: "Connect Alpha",
    },
  },
  beta: {
    id: "beta",
    name: "Beta",
    recommendation: {
      level: "recommended",
      rank: 10,
      headline: "Connect Beta",
    },
  },
  stable: {
    id: "stable",
    name: "Stable",
    recommendation: {
      level: "standard",
      rank: 1,
    },
  },
} as const

test("recommended providers sort by rank before standard providers", () => {
  const sorted = [
    { id: "zeta", name: "Zeta" },
    { id: "alpha", name: "Alpha" },
    { id: "stable", name: "Stable" },
    { id: "beta", name: "Beta" },
  ].sort((a, b) => compareProviderIDs(profiles, a, b))

  expect(sorted.map((provider) => provider.id)).toEqual(["beta", "alpha", "stable", "zeta"])
})

test("standard providers sort alphabetically", () => {
  const sorted = [
    { id: "zeta", name: "Zeta" },
    { id: "gamma", name: "Gamma" },
  ].sort((a, b) => compareProviderIDs(profiles, a, b))

  expect(sorted.map((provider) => provider.id)).toEqual(["gamma", "zeta"])
})

test("recommendation helpers distinguish grouping from connection state", () => {
  expect(isRecommendedProvider(profiles, "alpha")).toBe(true)
  expect(isRecommendedProvider(profiles, "stable")).toBe(false)
  expect(providerConnectCopy("alpha", profiles, "Alpha")).toBe("Connect Alpha")
  expect(providerConnectCopy("custom", profiles, "Custom")).toBe("Connect Custom")
})
