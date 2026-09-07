import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { RolloutProvenance } from "../../src/session/rollout/provenance"

test("workspace provenance distinguishes committed and dirty content without retaining file bodies", async () => {
  await using tmp = await tmpdir({ git: true })
  const clean = await RolloutProvenance.git(tmp.path)
  expect(clean?.commit).toMatch(/^[a-f0-9]{40}$/)
  await Bun.write(`${tmp.path}/untracked.txt`, "private contents")
  const dirty = await RolloutProvenance.git(tmp.path)
  expect(dirty?.commit).toBe(clean?.commit)
  expect(dirty?.dirty).toBe(true)
  expect(dirty?.statusSha256).not.toBe(clean?.statusSha256)
  expect(JSON.stringify(dirty)).not.toContain("private contents")
})
