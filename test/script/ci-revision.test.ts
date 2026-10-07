import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  decodeRevisionBlobs,
  decodeRevisionInventory,
  RevisionInputError,
  RevisionSnapshot,
} from "../../script/ci/revision"
import { workspaceInputs } from "../../script/ci/catalog"
import { selectionInputs, taskInputs } from "../../script/ci/inputs"

const revision = "a".repeat(40)
const body = Buffer.from("export const fixture = 1\n")
const oid = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex")
const entry = { mode: "100644", type: "blob", oid, path: "src/fixture.ts" } as const
const frame = Buffer.concat([Buffer.from(`${oid} blob ${body.length}\n`), body, Buffer.from("\n")])

function rejected(action: () => unknown, stage: string) {
  try {
    action()
    throw new Error("corrupt revision was admitted")
  } catch (error) {
    expect(error).toBeInstanceOf(RevisionInputError)
    expect(error).toMatchObject({ revision, stage })
  }
}

test("NUL inventory retains unusual paths and validates mode, type, OID and uniqueness", () => {
  const unusual = "src/tab\tand\nnewline.ts"
  const inventory = decodeRevisionInventory(revision, Buffer.from(`100644 blob ${oid}\t${unusual}\0`))
  expect([...inventory.keys()]).toEqual([unusual])
  for (const source of [
    `100644 blob ${oid}\tsrc/fixture.ts`,
    `100644 tree ${oid}\tsrc/fixture.ts\0`,
    `100600 blob ${oid}\tsrc/fixture.ts\0`,
    `100644 blob bad\tsrc/fixture.ts\0`,
    `100644 blob ${oid}\t../fixture.ts\0`,
    `100644 blob ${oid}\t\0`,
    `100644 blob ${oid}\tsrc/fixture.ts\0`.repeat(2),
    `100644 blob ${oid}\tsrc/fixture.ts\0garbage`,
  ])
    rejected(() => decodeRevisionInventory(revision, Buffer.from(source)), "inventory")
})

test("blob admission verifies complete framing, order, count and content identity atomically", () => {
  expect(decodeRevisionBlobs(revision, [entry], frame).get(entry.path)).toBe(body.toString())
  const secondBody = Buffer.from("second")
  const secondOid = createHash("sha1").update(`blob ${secondBody.length}\0`).update(secondBody).digest("hex")
  const second = { ...entry, oid: secondOid, path: "src/second.ts" }
  const secondFrame = Buffer.concat([
    Buffer.from(`${secondOid} blob ${secondBody.length}\n`),
    secondBody,
    Buffer.from("\n"),
  ])
  for (const [requested, output] of [
    [[entry], Buffer.from(`${oid} missing\n`)],
    [[entry], Buffer.from(`${oid} blob ${body.length}`)],
    [[entry], frame.subarray(0, frame.length - 2)],
    [[entry], frame.subarray(0, frame.length - 1)],
    [[entry], Buffer.concat([frame.subarray(0, -1), Buffer.from("x")])],
    [[entry], Buffer.from(`${oid} tree 0\n\n`)],
    [[entry], Buffer.from(`${oid} blob -1\n\n`)],
    [[entry], Buffer.from(`${oid} blob 1e2\n\n`)],
    [[entry], Buffer.from(`${oid} blob 9007199254740992\n\n`)],
    [
      [entry],
      Buffer.concat([Buffer.from(`${oid} blob ${body.length}\n`), Buffer.alloc(body.length), Buffer.from("\n")]),
    ],
    [[entry], Buffer.concat([frame, Buffer.from("trailing")])],
    [[entry], Buffer.concat([frame, frame])],
    [[entry, second], frame],
    [[entry, second], Buffer.concat([secondFrame, frame])],
  ] as const)
    rejected(() => decodeRevisionBlobs(revision, [...requested], output), "batch")
  expect([...decodeRevisionBlobs(revision, [entry, second], Buffer.concat([frame, secondFrame])).keys()]).toEqual([
    entry.path,
    second.path,
  ])
})

test("absent task roots remain incomplete but inventory-present unloaded inputs cannot become empty source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-revision-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@test",
      },
    }).trim()
  try {
    git("init", "--quiet")
    await Bun.write(path.join(root, "resource.bin"), "not preloaded")
    git("add", ".")
    git("commit", "--quiet", "-m", "fixture")
    const snapshot = new RevisionSnapshot(root, git("rev-parse", "HEAD"))
    expect(snapshot.read("absent.ts")).toBeUndefined()
    expect(() => snapshot.read("resource.bin")).toThrow(RevisionInputError)
    const tasks = [
      {
        id: "missing",
        kind: "rollout" as const,
        pool: "linux" as const,
        owners: [],
        needs: [],
        seconds: 1,
        inputs: ["absent.ts"],
      },
    ]
    expect(await taskInputs(snapshot, tasks, [])).toEqual({
      missing: { files: ["absent.ts"], packages: [], complete: false },
    })
    await expect(workspaceInputs(snapshot)).rejects.toThrow(RevisionInputError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("valid gitlinks remain inventory entries without becoming source or leaf tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-gitlinks-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@test",
      },
    }).trim()
  try {
    git("init", "--quiet")
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/core"] } }))
    await Bun.write(path.join(root, "packages/core/package.json"), JSON.stringify({ name: "core" }))
    await Bun.write(path.join(root, "packages/core/test/linked.test.ts"), 'import "bun:test"')
    await Bun.write(path.join(root, "packages/core/test/consumer.test.ts"), 'import "../src/linked.ts"')
    git("add", ".")
    git("commit", "--quiet", "-m", "base")
    const base = git("rev-parse", "HEAD")
    const before = new RevisionSnapshot(root, base)
    const linked = "packages/core/src/linked.ts"
    const linkedTest = "packages/core/test/linked.test.ts"
    git("update-index", "--add", "--cacheinfo", `160000,${base},${linked}`)
    git("update-index", "--add", "--cacheinfo", `160000,${"b".repeat(40)},${linkedTest}`)
    git("commit", "--quiet", "-m", "linked inputs")
    const snapshot = new RevisionSnapshot(root, git("rev-parse", "HEAD"))
    expect(snapshot.inventory.get(linked)).toMatchObject({ mode: "160000", type: "commit", oid: base })
    expect(snapshot.inventory.get(linkedTest)?.type).toBe("commit")
    expect(snapshot.files).not.toContain(linked)
    expect(snapshot.files).not.toContain(linkedTest)
    expect(snapshot.sources.has(linked)).toBe(false)
    expect(snapshot.read(linked)).toBeUndefined()
    expect(() => snapshot.required(linked)).toThrow(RevisionInputError)
    const workspaces = await workspaceInputs(snapshot)
    expect(workspaces).toEqual([{ directory: "packages/core", name: "core", dependencies: [], testDependencies: [] }])
    const tasks = [
      {
        id: "consumer",
        kind: "rollout" as const,
        pool: "linux" as const,
        owners: ["packages/core"],
        needs: [],
        seconds: 1,
        inputs: ["packages/core/test/consumer.test.ts"],
      },
      {
        id: "root",
        kind: "rollout" as const,
        pool: "linux" as const,
        owners: ["packages/core"],
        needs: [],
        seconds: 1,
        inputs: [linkedTest],
      },
    ]
    expect(await taskInputs(snapshot, tasks, workspaces)).toEqual({
      consumer: {
        files: ["packages/core/test/consumer.test.ts"],
        packages: [],
        complete: false,
      },
      root: { files: [linkedTest], packages: [], complete: false },
    })
    expect(await selectionInputs(snapshot, snapshot, [linkedTest], workspaces, workspaces)).toEqual({ leafTests: [] })
    expect(await selectionInputs(before, snapshot, [linkedTest], workspaces, workspaces)).toEqual({ leafTests: [] })
    expect(await selectionInputs(snapshot, before, [linkedTest], workspaces, workspaces)).toEqual({ leafTests: [] })
    await Bun.write(path.join(root, linkedTest), 'import { test } from "bun:test"; test("restored", () => {})')
    git("add", "--", linkedTest)
    git("commit", "--quiet", "-m", "restored blob")
    const restored = new RevisionSnapshot(root, git("rev-parse", "HEAD"))
    expect(restored.inventory.get(linkedTest)?.type).toBe("blob")
    expect(await selectionInputs(snapshot, restored, [linkedTest], workspaces, workspaces)).toEqual({ leafTests: [] })
    expect(await selectionInputs(before, restored, [linkedTest], workspaces, workspaces)).toEqual({
      leafTests: [linkedTest],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
