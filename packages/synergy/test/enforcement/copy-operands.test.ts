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
// spelling (pipelines, dynamic operands, mv, hard links, quoted or glob
// operands, redirections) keeps write classification.
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

function externalWrites(envelope: any): string[] {
  return envelope.capabilities
    .filter((cap: any) => cap.class === "file_external_write")
    .flatMap((cap: any) => cap.paths ?? [])
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

  test("install -m value form stays allowed", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "install -m 0755 /Users/test/.synergy/cache/tool ./bin/tool",
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

  test("cp -t to an external target directory remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp -t /Users/test/.synergy/cache/ ./file.txt",
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope)).toContain("/Users/test/.synergy/cache/")
  })

  test("cp -t with a relative external target directory remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp -t ../outside-cache ../outside-source",
    })

    expect(envelope.decision).toBe("deny")
    const writes = externalWrites(envelope)
    expect(writes.some((p: string) => p.endsWith("/outside-cache"))).toBe(true)
  })

  test("mv from an external source remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "mv /Users/test/.synergy/cache/models.json ./models.json",
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope)).toContain("/Users/test/.synergy/cache/models.json")
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
    expect(externalWrites(envelope)).toContain("/Users/test/.synergy/cache/models.json")
  })

  test("dynamic cp operand keeps conservative classification", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: 'cp /Users/test/.synergy/cache/models.json "$(pwd)/models.json"',
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope)).toContain("/Users/test/.synergy/cache/models.json")
  })

  test("quoted destination operand keeps conservative classification", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: 'cp ./src "/tmp/out dir/file"',
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope).some((p: string) => p.startsWith("/tmp/out"))).toBe(true)
  })

  test("ln hard link to an external source remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "ln /Users/test/.synergy/cache/models.json ./models-link",
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope)).toContain("/Users/test/.synergy/cache/models.json")
  })

  test("cp -l hard link from an external source remains an external write", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp -l /Users/test/.synergy/cache/models.json ./models-link",
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope)).toContain("/Users/test/.synergy/cache/models.json")
  })

  test("ln -s to an external source stays an external read", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "ln -s /Users/test/.synergy/cache/models.json ./models-link",
    })

    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((cap: any) => cap.class === "file_external_write")).toBe(false)
  })

  test("identical external source and destination keeps the write role", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command:
        "cp --force --backup=numbered /Users/test/.synergy/cache/models.json /Users/test/.synergy/cache/models.json",
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope)).toContain("/Users/test/.synergy/cache/models.json")
  })

  test("globbed copy source keeps conservative classification", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp /Users/test/.[s]sh/config ./config",
    })

    expect(envelope.decision).toBe("deny")
    expect(
      envelope.capabilities.some(
        (cap: any) => cap.class === "file_external_write" && cap.paths?.some((p: string) => p.includes("sh/config")),
      ),
    ).toBe(true)
  })

  test("copy with trailing redirection keeps conservative classification", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: "cp ./src /tmp/external-copy > ./log",
    })

    expect(envelope.decision).toBe("deny")
    expect(externalWrites(envelope).some((p: string) => p.startsWith("/tmp/external-copy"))).toBe(true)
  })
})
