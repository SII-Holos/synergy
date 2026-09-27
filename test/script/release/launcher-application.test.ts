import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { runtimeBuildPlan } from "../../../script/release/shared/runtime-build-plan"

test("the bundled launcher can prepare a local ZIP application without optional remote adapters", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-launcher-application-"))
  try {
    const entry = path.join(directory, "fixture.ts")
    await Bun.write(
      entry,
      `
import {prepareApplications} from ${JSON.stringify(new URL("../../../packages/plugin-host/src/installation/applications.ts", import.meta.url).pathname)};
const data = Buffer.from("UEsDBBQAAAAAAAoPOl17QzwzHAAAABwAAAALAAAAYXBwbGljYXRpb25wb3J0YWJsZSBhcHBsaWNhdGlvbiBmaXh0dXJlUEsBAhQDFAAAAAAACg86XXtDPDMcAAAAHAAAAAsAAAAAAAAAAAAAAIABAAAAAGFwcGxpY2F0aW9uUEsFBgAAAAABAAEAOQAAAEUAAAAAAA==", "base64");
const root = process.argv[2];
await prepareApplications(root, {fixture:{directory:"fixture",version:"1.0.0",spec:"1.0.0",metadata:{formatVersion:1,kind:"app",id:"fixture",version:"1.0.0",compatibility:{synergy:"*"},artifacts:[{target:"linux-x64",format:"zip",executable:"./application",url:"https://example.test/application.zip",sha256:new Bun.CryptoHasher("sha256").update(data).digest("hex"),signing:{type:"checksum"}}]}}}, {target:"linux-x64",fetch:async()=>new Response(data)});
console.log(await Bun.file(root+"/applications/fixture/application").text());
`,
    )
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      outdir: path.join(directory, "dist"),
      external: runtimeBuildPlan("core").external,
    })
    expect(result.success).toBe(true)
    await fs.mkdir(path.join(directory, "stage"))
    const child = Bun.spawn([process.execPath, result.outputs[0].path, path.join(directory, "stage")], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe("portable application fixture")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
