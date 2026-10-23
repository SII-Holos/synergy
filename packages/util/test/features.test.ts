import { expect, test } from "bun:test"
import { FeatureSelection, type FeatureComponent, type FeatureDefinition } from "../src/features"

const boss: FeatureDefinition = {
  id: "boss",
  owner: "boss",
  maturity: "experimental",
  activation: "restart",
  name: "Boss",
  description: "Autonomous coordination",
  component: "boss",
}
const component = (id: string, input: Partial<FeatureComponent> = {}): FeatureComponent => ({
  id,
  version: "1.0.0",
  features: { kind: "foundation", definitions: [] },
  ...input,
})
const candidates = [
  component("library"),
  component("boss", { requires: { library: "1.0.0" }, features: { kind: "product", definitions: [boss] } }),
  component("feishu"),
  component("boss-feishu", {
    requires: { boss: "1.0.0", feishu: "1.0.0" },
    features: { kind: "bridge", definitions: [] },
  }),
]

test("experiments default off and bridges cannot reactivate a disabled endpoint", () => {
  expect(FeatureSelection.resolve(candidates).components).toEqual(["library", "feishu"])
  expect(FeatureSelection.resolve(candidates, { optIn: ["boss"] }).components).toEqual(candidates.map((x) => x.id))
  expect(FeatureSelection.resolve(candidates, { selection: { "boss-feishu": "1.0.0" } }).components).toEqual([])
})

test("a stable product cannot depend on an experimental component", () => {
  const stable = component("stable", {
    requires: { boss: "1.0.0" },
    features: {
      kind: "product",
      definitions: [{ ...boss, id: "stable", owner: "stable", component: "stable", maturity: "stable" }],
    },
  })
  expect(() => FeatureSelection.resolve([...candidates, stable], { optIn: ["boss"] })).toThrow("optional integration")
  expect(() =>
    FeatureSelection.resolve([...candidates, component("stable", { requires: { "boss-feishu": "1.0.0" } })]),
  ).toThrow("optional integration")
  expect(() =>
    FeatureSelection.resolve([...candidates, component("stable", { requires: { "boss-feishu": "1.0.0" } })], {
      optIn: ["boss"],
    }),
  ).toThrow("optional integration")
})

test("selection preserves exact versions, dependencies and unavailable choices without installing", () => {
  const plan = FeatureSelection.resolve(candidates, { selection: { boss: "1.0.0" }, optIn: ["boss", "missing"] })
  expect(plan.components).toEqual(["library", "boss"])
  expect(plan.optIn).toEqual(["boss", "missing"])
  expect(() => FeatureSelection.resolve(candidates, { selection: { boss: "2.0.0" } })).toThrow("exact version")
  expect(() => FeatureSelection.resolve(candidates, { selection: { missing: "1.0.0" } })).toThrow("not installed")
})

test("graduation is independent of old opt-ins and requires no second execution path", () => {
  const stable = candidates.map((x) =>
    x.id === "boss"
      ? { ...x, features: { kind: "product" as const, definitions: [{ ...boss, maturity: "stable" as const }] } }
      : x,
  )
  expect(FeatureSelection.resolve(stable).components).toEqual(candidates.map((x) => x.id))
  expect(FeatureSelection.resolve(stable, { optIn: ["boss"] }).components).toEqual(candidates.map((x) => x.id))
})

test("catalog rejects duplicate identities and live component gates", () => {
  expect(() => FeatureSelection.resolve([...candidates, candidates[0]!])).toThrow("Duplicate component")
  expect(() =>
    FeatureSelection.resolve([
      component("boss", { features: { kind: "product", definitions: [{ ...boss, activation: "live" }] } }),
    ]),
  ).toThrow("restart")
})

test("behavior experiments cannot activate inside an unavailable owner", () => {
  const behavior: FeatureDefinition = { ...boss, id: "boss.prompt", component: undefined, activation: "live" }
  const plan = FeatureSelection.resolve(
    candidates.map((candidate) =>
      candidate.id === "boss"
        ? { ...candidate, features: { kind: "product" as const, definitions: [boss, behavior] } }
        : candidate,
    ),
    { optIn: ["boss.prompt"] },
  )
  expect(FeatureSelection.status(plan, plan.optIn, []).find((item) => item.id === "boss.prompt")).toMatchObject({
    selected: true,
    enabled: false,
    available: false,
    reason: "dependency-unavailable",
  })
})

test("saved dependencies determine pending restart without changing effective availability", () => {
  const child: FeatureDefinition = { ...boss, id: "child", owner: "child", component: "child" }
  const behavior: FeatureDefinition = { ...child, id: "child.prompt", component: undefined, activation: "live" }
  const plan = FeatureSelection.resolve(
    [
      ...candidates,
      component("child", {
        requires: { boss: "1.0.0" },
        features: { kind: "product", definitions: [child, behavior] },
      }),
    ],
    { optIn: ["child", "child.prompt"] },
  )
  const requested = ["boss", "child", "child.prompt"]
  const pending = FeatureSelection.status(plan, requested, [])
  expect(pending.find((item) => item.id === "child")).toMatchObject({
    available: true,
    enabled: false,
    pendingRestart: true,
  })
  expect(pending.find((item) => item.id === "child.prompt")).toMatchObject({
    available: true,
    enabled: false,
    pendingRestart: true,
  })
  const running = FeatureSelection.resolve(
    [
      ...candidates,
      component("child", {
        requires: { boss: "1.0.0" },
        features: { kind: "product", definitions: [child, behavior] },
      }),
    ],
    { optIn: requested },
  )
  const disabled = FeatureSelection.status(running, ["child", "child.prompt"], requested)
  expect(disabled.find((item) => item.id === "child")).toMatchObject({
    available: false,
    enabled: true,
    pendingRestart: true,
  })
  expect(disabled.find((item) => item.id === "child.prompt")).toMatchObject({
    available: false,
    enabled: true,
    pendingRestart: true,
  })
})
