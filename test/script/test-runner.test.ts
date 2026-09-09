import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

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
    ]) {
      await Bun.write(
        path.join(root, `test/${file}.test.ts`),
        `import {expect,test} from "bun:test";import mode from "condition-probe";import {readMode} from "../src/probe";test("${file}",async()=>{expect(readMode(mode)).toBe("${mode}");const file=Bun.file("${file}.runs");await Bun.write(file,(await file.text().catch(()=>""))+"run\\n")})`,
      )
    }
    const runner = path.resolve(import.meta.dirname, "../../script/shared/test-runner.ts")
    await Bun.write(
      path.join(root, "run.ts"),
      `import {runBatchedTests} from ${JSON.stringify(runner)};await runBatchedTests({root:import.meta.dirname,timeoutMs:10000,isolated:["test/browser.test.ts"],browserOnly:["test/browser.test.ts"]})`,
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
