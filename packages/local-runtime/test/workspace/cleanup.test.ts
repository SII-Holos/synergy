import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { createWorkspaceCleanupHost } from "../../src/workspace/cleanup"

test("a cleanup Host reads the existing namespace and snapshots its explicit environment without opening storage", async () => {
  await using fixture = await runtimeHome()
  const { home, root } = fixture.host
  const identity = await fixture.host.workspaceLocation!.hostID()
  const environment = { CLEANUP_FIXTURE: "before", SYNERGY_HOME: "ignored", SYNERGY_RUNTIME_ROOT: "ignored" }
  const before = (await fs.readdir(root)).sort()
  const host = await createWorkspaceCleanupHost({ home, root, env: environment })
  environment.CLEANUP_FIXTURE = "after"
  expect(host.home).toBe(home)
  expect(host.root).toBe(root)
  expect(host.env).toEqual({ CLEANUP_FIXTURE: "before", SYNERGY_HOME: home, SYNERGY_RUNTIME_ROOT: root })
  expect(await host.workspaceLocation!.hostID()).toBe(identity)
  expect(await host.workspaceLocation!.identify(home)).toMatchObject({ path: await fs.realpath(home) })
  expect((await fs.readdir(root)).sort()).toEqual(before)
})

test("a cleanup Host refuses absent or corrupt namespace identity without initializing or replacing it", async () => {
  await using fixture = await runtimeHome()
  const { home, root } = fixture.host
  const identity = path.join(root, "workspace-host")
  const before = (await fs.readdir(root)).sort()
  await expect(createWorkspaceCleanupHost({ home, root })).rejects.toMatchObject({ code: "ENOENT" })
  expect((await fs.readdir(root)).sort()).toEqual(before)
  await fs.writeFile(identity, "corrupt-existing-identity")
  await expect(createWorkspaceCleanupHost({ home, root })).rejects.toThrow(
    "Invalid local filesystem namespace identity",
  )
  expect(await fs.readFile(identity, "utf8")).toBe("corrupt-existing-identity")
  await expect(createWorkspaceCleanupHost({ home: "relative-home", root })).rejects.toThrow("existing absolute Home")
  await expect(createWorkspaceCleanupHost({ home, root: "relative-root" })).rejects.toThrow("existing absolute Home")
})
