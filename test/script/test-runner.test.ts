import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { batchInvocation, collectTests, shardMainFiles } from "../../packages/testing/script/batches"
import { executionBatches } from "../../packages/testing/script/run"

test("a browser-only isolated suite runs once with browser conditions and separate coverage shards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-browser-test-runner-"))
  try {
    await Bun.write(
      path.join(root, "node_modules/condition-probe/package.json"),
      JSON.stringify({ type: "module", exports: { browser: "./browser.js", default: "./server.js" } }),
    )
    await Bun.write(path.join(root, "node_modules/condition-probe/browser.js"), 'export default "browser"')
    await Bun.write(path.join(root, "node_modules/condition-probe/server.js"), 'export default "server"')
    await Bun.write(path.join(root, "src/probe.ts"), "export function readMode(value: string) {return value}\n")
    for (const [file, mode] of [
      ["browser", "browser"],
      ["server", "server"],
      ["browser-shared-a", "browser"],
      ["browser-shared-b", "browser"],
      ["isolated", "server"],
      ["extra", "server"],
    ]) {
      await Bun.write(
        path.join(root, `test/${file}.test.ts`),
        `import {expect,test} from "bun:test";import mode from "condition-probe";import {readMode} from "../src/probe";test("${file}",async()=>{expect(readMode(mode)).toBe("${mode}");const file=Bun.file("${file}.runs");await Bun.write(file,(await file.text().catch(()=>""))+"run\\n")})`,
      )
    }
    const runner = path.resolve(import.meta.dirname, "../../script/shared/test-runner.ts")
    await Bun.write(
      path.join(root, "run.ts"),
      `import {runBatchedTests} from ${JSON.stringify(runner)};await runBatchedTests({root:import.meta.dirname,timeoutMs:10000,isolated:["test/browser.test.ts","test/isolated.test.ts"],browserOnly:["test/browser.test.ts","test/browser-shared-a.test.ts","test/browser-shared-b.test.ts"],extraSerial:["test/extra.test.ts"]})`,
    )
    const child = Bun.spawn([process.execPath, "run", "run.ts", "--coverage"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, diagnostic: code ? output + errors : "" }).toEqual({ code: 0, diagnostic: "" })
    expect(await Bun.file(path.join(root, "browser.runs")).text()).toBe("run\n")
    expect(await Bun.file(path.join(root, "server.runs")).text()).toBe("run\n")
    expect(await Bun.file(path.join(root, "coverage/shards/0/lcov.info")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "coverage/shards/1/lcov.info")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "coverage/shards/0/junit.xml")).text()).toContain("<testcase")
    expect(await Bun.file(path.join(root, "coverage/shards/1/junit.xml")).text()).toContain("<testcase")
    const expected = [
      ["test/server.test.ts"],
      ["test/browser.test.ts"],
      ["test/isolated.test.ts"],
      ["test/browser-shared-a.test.ts", "test/browser-shared-b.test.ts"],
      ["test/extra.test.ts"],
    ]
    for (const [index, files] of expected.entries()) {
      expect((await Bun.file(path.join(root, `coverage/shards/${index}/timing.json`)).json()).files).toEqual(files)
      for (const file of files)
        expect(await Bun.file(path.join(root, file.replace("test/", "").replace(".test.ts", ".runs"))).text()).toBe(
          "run\n",
        )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("capacity measurement owns one process without changing its inventory or hash partition", async () => {
  const root = path.resolve(import.meta.dirname, "../../packages/organization-runtime")
  const capacity = "test/capacity-sync.test.ts"
  const files = (await collectTests("test", root)).toSorted()
  const original = shardMainFiles(
    files.filter((file) => file !== "test/runtime.test.ts"),
    4,
  ).find((batch) => batch.includes(capacity))!
  const batches = executionBatches(original, root, 4)
  const selected = batches.filter((batch) => batch.files.includes(capacity))
  expect(selected.map((batch) => batch.files)).toEqual([[capacity]])
  const partition = shardMainFiles([capacity], 4).findIndex((batch) => batch.length > 0)
  expect(selected[0]?.partition).toBe(partition)
  const siblings = original.filter((file) => file !== capacity)
  expect(batches.filter((batch) => !batch.files.includes(capacity))).toEqual(executionBatches(siblings, root, 4))
  const observed = batches.flatMap((batch) => batch.files)
  expect(observed.toSorted()).toEqual(original.toSorted())
  expect(new Set(observed).size).toBe(original.length)
  const complete = executionBatches(files, root, 4).flatMap((batch) => batch.files)
  expect(complete.toSorted()).toEqual(files)
  expect(new Set(complete).size).toBe(files.length)
  const args = ["test", "--coverage", capacity]
  expect(batchInvocation(args, root)).toEqual({ args, cwd: root })
})
