import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Skill } from "../../src/skill"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { tmpdir } from "../fixture/fixture"

const SKILL_NAME = "qizhi-synergy-link"

describe.serial("qizhi-synergy-link builtin skill", () => {
  test("is registered as a canonical builtin with a triggering description", async () => {
    const names = BUILTIN_SKILLS.map((skill) => skill.name)
    expect(names).toContain(SKILL_NAME)

    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === SKILL_NAME)!
    expect(Skill.Manifest.safeParse({ name: builtin.name, description: builtin.description }).success).toBe(true)
    expect(builtin.builtin).toBe(true)
    expect(builtin.references ?? {}).toEqual({})
    expect(builtin.description.toLowerCase()).toContain("qizhi")
    expect(builtin.description.toLowerCase()).toContain("synergy link")
    expect(builtin.description.toLowerCase()).toContain("shared-filesystem")
  })

  test("loads through the runtime catalog as a memory-backed builtin", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = await Skill.get(SKILL_NAME)
        expect(skill).toBeDefined()
        expect(skill!.origin).toEqual({ kind: "builtin" })
        expect(skill!.backing.kind).toBe("memory")
        expect(skill!.diagnostics).toEqual([])
      },
    })
  })

  test("keeps the no-shared-state rules and unsupported duplicate topology in content", async () => {
    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === SKILL_NAME)!
    const content = builtin.content.toLowerCase()

    // The supported one-device/one-agent boundary must stay explicit.
    expect(builtin.content).toContain("One physical/device instance")
    expect(builtin.content).toContain("One Holos Agent ID")

    // Cross-host duplicate detection must never be claimed as solved.
    expect(builtin.content).toContain("last-writer-wins")
    expect(builtin.content).toContain("never claim duplicate detection is solved")

    // A replacement device receives a new identity; copied credentials are never a failover mechanism.
    expect(builtin.content).toContain("Never move an Agent ID to another device as failover")
    expect(builtin.content).toContain("distinct Holos Agent identity")
    expect(builtin.content).toContain("atomically relink")

    // Per-instance namespace variables and the host home override must stay present.
    expect(builtin.content).toContain("SYNERGY_LINK_HOME")
    expect(builtin.content).toContain("$INSTANCE_ROOT")
    expect(builtin.content).toContain("$SYNERGY_HOME/.synergy/")
    expect(builtin.content).toContain("$HOME/.synergy/data/auth/api-key.json")

    // The forbidden shared-state list must survive content edits.
    for (const forbidden of [
      "Writable `HOME`",
      "Synergy runtime data",
      "Holos credential stores",
      "`SYNERGY_LINK_HOME`",
      "Control sockets",
    ]) {
      expect(builtin.content).toContain(forbidden)
    }

    expect(builtin.content).toContain("Status source: live")
    expect(builtin.content).toContain("snapshot (last-known)")
    expect(builtin.content).toContain("not applicable in standalone mode")
    expect(builtin.content).toContain("clamps `yieldSeconds` to five seconds")
    expect(builtin.content).toContain("belongs to the authenticated collaboration session")
    expect(builtin.content).toContain("same request ID are idempotent inside one session")
    expect(builtin.content).toContain("TMPDIR=$INSTANCE_ROOT/tmp")
    expect(builtin.content).toContain("Qizhi workload/container supervisor")
    expect(builtin.content).toContain("Qizhi platform terminal is the required independent recovery channel")
    expect(builtin.content).toContain("## Rollback")
    expect(builtin.content).toContain("distinct from the Synergy application")
    expect(builtin.content).toContain('bash targetID=<TARGET_ID> yieldSeconds=5 command="hostname"')
    expect(builtin.content).toContain("--agent-secret-file")
    expect(builtin.content).not.toContain("--agent-secret <")

    const deploySection = builtin.content.slice(
      builtin.content.indexOf("## Deploy and Start"),
      builtin.content.indexOf("## Verify"),
    )
    expect(deploySection.indexOf("synergy-link login")).toBeGreaterThanOrEqual(0)
    expect(deploySection.indexOf("synergy-link login")).toBeLessThan(deploySection.indexOf("synergy-link start"))

    // Operational workflow sections must remain loadable guidance.
    for (const section of [
      "## Preflight",
      "## Deploy and Start",
      "## Verify",
      "## Sender Target Setup and Test",
      "## Safe Remote Work",
      "## Incident Recovery",
      "## Credential Rotation and Relink",
      "## Stop Conditions",
      "## Qizhi Examples",
    ]) {
      expect(builtin.content).toContain(section)
    }
  })
})
