import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OrganizationRecoveryAdministration as Recovery } from "../src/backup/administration-recovery"
import { openOrganizationService } from "../src/service"
import { preparedFixture } from "./support/recovery-administration"

test("a restored Service reopens through an ancestor alias without changing its native installation", async () => {
  await using f = await preparedFixture()
  const recovered = await Recovery.recover(f.input)
  expect(recovered.executionEnabled).toBe(false)
  const home = await fs.realpath(f.input.home)
  const intentFile = path.join(home, ".synergy", "home-restoration.json")
  const intent = await fs.readFile(intentFile)
  const databaseFile = path.join(home, ".synergy", "data", "organization.sqlite")
  const database = await fs.stat(databaseFile, { bigint: true })
  const parent = path.join(f.root, "target-parent-alias")
  await fs.symlink(path.dirname(home), parent, "dir")
  const alias = path.join(parent, path.basename(home))
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(false)
  expect(await fs.realpath(alias)).toBe(home)
  await using service = await openOrganizationService({ home: alias })
  expect(service.home).toBe(home)
  expect((await service.fetch(new Request("https://recovered.example/org/v1/ready"))).status).toBe(200)
  await service.close()
  const direct = path.join(f.root, "direct-home-alias")
  await fs.symlink(home, direct, "dir")
  await expect(openOrganizationService({ home: direct })).rejects.toThrow("ordinary native directory")
  const retained = await fs.stat(databaseFile, { bigint: true })
  expect({ device: retained.dev, inode: retained.ino }).toEqual({ device: database.dev, inode: database.ino })
  expect(await fs.readFile(intentFile)).toEqual(intent)
  expect(await f.materialHash()).toBe(f.originalKey)
}, 30_000)
