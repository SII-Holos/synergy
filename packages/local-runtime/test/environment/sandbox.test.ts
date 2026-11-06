import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { executionSandbox } from "../../src/environment/sandbox"

test("execution-host policies retain protected paths, declared writes and private temporary writes", async () => {
  await using fixture = await tmpdir()
  const directory = path.join(fixture.path, "policies")
  const workspace = path.join(fixture.path, "workspace")
  const shared = path.join(fixture.path, "shared")
  const protectedRoot = path.join(fixture.path, "receipts")
  const dataRoot = path.join(fixture.path, "private")
  const host = executionSandbox({ home: fixture.path, directory, helper: "/helper", protectedRoots: [protectedRoot] })
  for (const mode of ["read_only", "workspace_write"] as const) {
    const wrapper = host.prepareWrapper({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace,
      sandboxMode: mode,
      extraWritableRoots: [shared],
      dataDenyRoots: [dataRoot],
    })
    try {
      expect(wrapper.sandboxed).toBe(true)
      expect(wrapper.command).toBe("/helper")
      expect(wrapper.args).toEqual([
        "--sandbox-policy-cwd",
        workspace,
        "--permission-profile",
        wrapper.tempPath!,
        "--",
        "/bin/sh",
        "-c",
        "true",
      ])
      const profile = await Bun.file(wrapper.tempPath!).json()
      const roots = mode === "read_only" ? [] : [workspace, shared]
      expect(profile.fileSystem.writableRoots).toEqual(roots)
      expect(profile.fileSystem.dataDenyRoots).toContain(protectedRoot)
      expect(profile.fileSystem.dataDenyRoots).toContain(dataRoot)
      expect(profile.fileSystem.dataDenyRoots).toContain(path.join(fixture.path, ".ssh"))
      expect(profile.network).toMatchObject({ mode: "restricted", allowLocalBinding: false, allowedUnixSockets: [] })
      expect(wrapper.writeFootprint).toEqual({
        kind: "roots",
        roots: [...roots, path.join(workspace, ".synergy", "tmp")],
      })
      if (process.platform !== "win32") expect((await fs.stat(wrapper.tempPath!)).mode & 0o777).toBe(0o444)
    } finally {
      host.cleanupWrapper(wrapper)
    }
    expect(await Bun.file(wrapper.tempPath!).exists()).toBe(false)
  }
  const direct = host.prepareWrapper({ command: "/bin/sh", args: ["-c", "true"], workspace, sandboxMode: "none" })
  expect(direct).toEqual({ command: "/bin/sh", args: ["-c", "true"], sandboxed: false })
  host.cleanupWrapper(direct)
  expect(await fs.readdir(directory)).toEqual([])
})
