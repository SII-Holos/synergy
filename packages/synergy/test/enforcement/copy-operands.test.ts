import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")

// ---------------------------------------------------------------------------
// enforcement/copy-operands.test.ts
//
// Copy-family shell commands (cp, install, ln) write only their final
// positional operand — or the -t/--target-directory value. Every other
// operand is a read-only source and must classify as a read so importing
// external files into the workspace is not treated as an external write.
// Every destination form (positional, -t, external) and every non-plain
// spelling (pipelines, dynamic operands, mv) keeps write classification.
// ---------------------------------------------------------------------------

const WORKSPACE = "/Users/test/synergy/.synergy/worktrees/feature-x"

async function autonomousGate() {
  return EnforcementGate.create({
    activeWorkspace: WORKSPACE,
    workspaceType: "worktree",
    originalCheckout: "/Users/test/synergy",
    profileId: "autonomous",
    readRoots: ["/Users/test/.synergy"],
  })
}

describe("copy operand classification", () => {
  test("cp importing an external file into the workspace is allowed", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp /Users/test/.synergy/cache/models.json dev-home/fork-test/.synergy/cache/",
    })

    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((cap: any) => cap.class === "file_external_write")).toBe(false)
    const sourceRead = envelope.capabilities.find(
      (cap: any) =>
        (cap.class === "file_read" || cap.class === "file_external_read") &&
        cap.paths?.includes("/Users/test/.synergy/cache/models.json"),
    )!
    expect(sourceRead).toBeDefined()
    const write = envelope.capabilities.find((cap: any) => cap.class === "file_write")!
    expect(write.paths?.some((p: string) => p.includes("dev-home/fork-test/.synergy/cache/"))).toBe(true)
  })

  test("chained cp imports stay allowed", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command:
        "cp /Users/test/.synergy/cache/provider-model-catalogs.v1.json dev-home/fork-test/.synergy/cache/ && cp /Users/test/.synergy/cache/models.json dev-home/fork-test/.synergy/cache/",
    })

    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((cap: any) => cap.class === "file_external_write")).toBe(false)
  })

  test("flagged cp imports stay allowed", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp -R --preserve=timestamps /Users/test/.synergy/cache/node_modules ./vendor-cache",
    })

    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((cap: any) => cap.class === "file_external_write")).toBe(false)
  })

  test("cp -t into the workspace is allowed", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp -t dev-home/fork-test/.synergy/cache/ /Users/test/.synergy/cache/models.json",
    })

    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((cap: any) => cap.class === "file_external_write")).toBe(false)
  })

  test("cp to an external destination remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp ./file.txt /Users/test/.synergy/cache/file.txt",
    })

    expect(envelope.decision).toBe("deny")
    const externalWrite = envelope.capabilities.find((cap: any) => cap.class === "file_external_write")!
    expect(externalWrite).toBeDefined()
    expect(externalWrite.nonBypassable).toBe(true)
    expect(externalWrite.paths).toContain("/Users/test/.synergy/cache/file.txt")
  })

  test("cp -t to an external destination remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp -t /Users/test/.synergy/cache/ ./file.txt",
    })

    expect(envelope.decision).toBe("deny")
    expect(
      envelope.capabilities.some(
        (cap: any) => cap.class === "file_external_write" && cap.paths?.includes("/Users/test/.synergy/cache/"),
      ),
    ).toBe(true)
  })

  test("mv from an external source remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "mv /Users/test/.synergy/cache/models.json ./models.json",
    })

    expect(envelope.decision).toBe("deny")
    expect(
      envelope.capabilities.some(
        (cap: any) =>
          cap.class === "file_external_write" && cap.paths?.includes("/Users/test/.synergy/cache/models.json"),
      ),
    ).toBe(true)
  })

  test("cp of a credential source still carries secrets on the read side", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp /Users/test/.ssh/id_rsa ./id_rsa",
    })

    const secrets = envelope.capabilities.find((cap: any) => cap.class === "secrets")!
    expect(secrets).toBeDefined()
    expect(secrets.nonBypassable).toBe(true)
  })

  test("pipelined cp keeps conservative all-write classification", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp /Users/test/.synergy/cache/models.json ./models.json | wc -c",
    })

    expect(envelope.decision).toBe("deny")
    expect(
      envelope.capabilities.some(
        (cap: any) =>
          cap.class === "file_external_write" && cap.paths?.includes("/Users/test/.synergy/cache/models.json"),
      ),
    ).toBe(true)
  })

  test("dynamic cp operand keeps conservative classification", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: 'cp /Users/test/.synergy/cache/models.json "$(pwd)/models.json"',
    })

    expect(envelope.decision).toBe("deny")
    expect(
      envelope.capabilities.some(
        (cap: any) =>
          cap.class === "file_external_write" && cap.paths?.includes("/Users/test/.synergy/cache/models.json"),
      ),
    ).toBe(true)
  })
})
