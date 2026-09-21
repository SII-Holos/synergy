import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MacBackend } from "../../src/sandbox/macos"

describe.skipIf(process.platform !== "darwin")("macOS native Keychain access", () => {
  let root: string
  let probe: string

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-keychain-")))
    probe = path.join(root, "keychain-service-probe")
    const compiled = Bun.spawnSync(["/usr/bin/clang", "-x", "c", "-", "-o", probe], {
      stdin: Buffer.from(`
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>

int main(void) {
  mach_port_t service = MACH_PORT_NULL;
  kern_return_t result = bootstrap_look_up(bootstrap_port, "com.apple.SecurityServer", &service);
  if (result != KERN_SUCCESS) {
    fprintf(stderr, "Keychain service lookup failed: %d\\n", result);
    return 1;
  }
  mach_port_deallocate(mach_task_self(), service);
  return 0;
}
`),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect({ code: compiled.exitCode, stderr: compiled.stderr.toString() }).toEqual({ code: 0, stderr: "" })
    expect(Bun.spawnSync([probe]).exitCode).toBe(0)
  })

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  for (const sandboxMode of ["workspace_write", "read_only"] as const) {
    for (const networkMode of ["full", "restricted"] as const) {
      test(`${sandboxMode}/${networkMode}: Keychain service is reachable while files remain contained`, () => {
        const workspace = path.join(root, `${sandboxMode}-${networkMode}`)
        const secret = path.join(root, `${sandboxMode}-${networkMode}-secret`)
        const external = path.join(root, `${sandboxMode}-${networkMode}-external`)
        const output = path.join(workspace, "output")
        fs.mkdirSync(workspace)
        fs.writeFileSync(secret, "synthetic credential")
        fs.writeFileSync(external, "original")
        expect(Bun.spawnSync(["/bin/cat", secret]).stdout.toString()).toBe("synthetic credential")

        const run = (command: string, args: string[] = []) => {
          const wrapper = MacBackend.prepare({
            command,
            args,
            workspace,
            sandboxMode,
            networkMode,
            dataDenyRoots: [secret],
          })
          try {
            expect(wrapper.sandboxed).toBe(true)
            return Bun.spawnSync([wrapper.command, ...wrapper.args], { stdout: "pipe", stderr: "pipe" })
          } finally {
            if (wrapper.tempPath) MacBackend.cleanupTemp(wrapper.tempPath)
          }
        }

        const lookup = run(probe)
        expect({ code: lookup.exitCode, stderr: lookup.stderr.toString() }).toEqual({ code: 0, stderr: "" })
        expect(run("/bin/cat", [secret]).exitCode).not.toBe(0)
        expect(run("/bin/sh", ["-c", 'printf changed > "$1"', "probe", external]).exitCode).not.toBe(0)
        expect(fs.readFileSync(external, "utf8")).toBe("original")
        const write = run("/bin/sh", ["-c", 'printf allowed > "$1"', "probe", output])
        if (sandboxMode === "workspace_write") expect(write.exitCode).toBe(0)
        else expect(write.exitCode).not.toBe(0)
        expect(fs.existsSync(output)).toBe(sandboxMode === "workspace_write")
      })
    }
  }
})
