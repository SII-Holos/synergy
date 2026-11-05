import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

test.skipIf(process.platform !== "win32")(
  "Windows application signatures ignore inherited PowerShell 7 modules without weakening publisher checks",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-windows-signature-"))
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
    )
    const inherited = Object.entries(process.env).filter(([key]) => key.toLowerCase() === "psmodulepath")
    const run = async (command: string[], env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    try {
      const core = await run(["pwsh.exe", "-NoProfile", "-NonInteractive", "-Command", "$PSHOME"], environment)
      expect(core.code).toBe(0)
      const modules = path.join(core.stdout.trim(), "Modules")
      expect((await fs.stat(modules)).isDirectory()).toBe(true)
      const executable = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
      const probe = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; $s = Get-AuthenticodeSignature -LiteralPath $env:SYNERGY_VERIFY_APP; @{ status = [string]$s.Status; publisher = $s.SignerCertificate.GetNameInfo('SimpleName', $false) } | ConvertTo-Json -Compress",
      ]
      const clean = await run(probe, { ...environment, SYNERGY_VERIFY_APP: executable })
      expect({ code: clean.code, stderr: clean.stderr }).toEqual({ code: 0, stderr: "" })
      const signature = JSON.parse(clean.stdout)
      expect(signature.status).toBe("Valid")
      expect(signature.publisher.length).toBeGreaterThan(0)
      const polluted = { ...environment, pSmOdUlEpAtH: modules, SYNERGY_VERIFY_APP: executable }
      const broken = await run(probe, polluted)
      expect(broken.code).not.toBe(0)
      expect(broken.stderr).toContain("Get-AuthenticodeSignature")

      const unsigned = path.join(directory, "unsigned.ps1")
      await Bun.write(unsigned, "Write-Output 'unsigned application fixture'\n")
      const source = pathToFileURL(path.resolve(import.meta.dir, "../../src/installation/applications.ts")).href
      const result = await run(
        [
          process.execPath,
          "--eval",
          `import { inspectWindowsApplicationSignature, verifyApplicationSignature } from ${JSON.stringify(source)};
const executable = ${JSON.stringify(executable)};
const artifact = { signing: { type: "authenticode", publisher: ${JSON.stringify(signature.publisher)} } };
const before = JSON.stringify(process.env);
const signed = await inspectWindowsApplicationSignature(executable);
await verifyApplicationSignature(executable, artifact);
let wrongPublisher = "";
try { await verifyApplicationSignature(executable, { signing: { type: "authenticode", publisher: "Unrelated publisher" } }); }
catch (error) { wrongPublisher = String(error); }
let missing = "";
try { await inspectWindowsApplicationSignature(${JSON.stringify(path.join(directory, "missing.exe"))}); }
catch (error) { missing = String(error); }
const unsigned = await inspectWindowsApplicationSignature(${JSON.stringify(unsigned)});
console.log(JSON.stringify({ signed, unsigned, wrongPublisher, missing, environmentUnchanged: before === JSON.stringify(process.env) }));`,
        ],
        polluted,
      )
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
      const inspected = JSON.parse(result.stdout)
      expect(inspected.signed).toEqual(signature)
      expect(inspected.unsigned).toEqual({ status: "NotSigned", publisher: "" })
      expect(inspected.wrongPublisher).toContain("signature or publisher is invalid")
      expect(inspected.missing).toContain("Application signature inspection failed")
      expect(inspected.environmentUnchanged).toBe(true)
      expect(Object.entries(process.env).filter(([key]) => key.toLowerCase() === "psmodulepath")).toEqual(inherited)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
