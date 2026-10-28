import { expect, test } from "bun:test"
import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerWorkerComponents, workerPlan } from "@ericsanchezok/synergy-agent-runtime/workers"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { fullComponents } from "../../src/components"

const components = RuntimeComponents.resolve([
  localRuntime({ workers: false, environment: false }),
  plugins(),
  ...fullComponents(),
])
const selectedOwners = [
  "agenda",
  "light-loop",
  "blueprint",
  "lattice",
  "boss",
  "anima",
  "channels",
  "channel-feishu",
  "github",
  "channel-github",
  "email",
  "agenda-blueprint",
  "agenda-light-loop",
  "plugin-agenda",
  "plugin-blueprint",
  "plugin-light-loop",
  "boss-feishu",
  "github-agenda",
  "channel-blueprint",
  "channel-light-loop",
  "channel-lattice",
]

function closure(id: string): RuntimeComponent[] {
  const selected = new Set<string>()
  function visit(owner: string) {
    const component = components.find((item) => item.id === owner)
    if (!component) throw new Error(`Missing selected component: ${owner}`)
    if (selected.has(owner)) return
    selected.add(owner)
    for (const dependency of Object.keys(component.requires ?? {})) visit(dependency)
  }
  visit(id)
  return RuntimeComponents.resolve(components.filter((item) => selected.has(item.id)))
}

for (const owner of selectedOwners) {
  test(`${owner} loads through the worker's pinned component protocol with only its required closure`, async () => {
    await using fixture = await runtimeHome()
    const selection = closure(owner)
    const plan = workerPlan(selection, FeatureSelection.complete(selection))
    expect(plan.agent.map((entry) => entry.id)).toContain(owner)
    expect(plan.agent.every((entry) => selection.some((component) => component.id === entry.id))).toBe(true)
    const context = RuntimeContext.create({
      ...fixture.host,
      env: { ...fixture.host.env, SYNERGY_WORKER_COMPONENTS: JSON.stringify(plan) },
    })
    try {
      await expect(context.run(() => registerWorkerComponents("agent"))).resolves.toBeUndefined()
    } finally {
      context.dispose()
    }
  })
}

for (const role of ["agent", "policy"] as const) {
  test(`full ${role} worker registers exactly the pinned role plan`, async () => {
    await using fixture = await runtimeHome()
    const context = RuntimeContext.create({
      ...fixture.host,
      env: {
        ...fixture.host.env,
        SYNERGY_WORKER_COMPONENTS: JSON.stringify(workerPlan(components, FeatureSelection.complete(components))),
      },
    })
    try {
      await expect(context.run(() => registerWorkerComponents(role))).resolves.toBeUndefined()
    } finally {
      context.dispose()
    }
  })
}
