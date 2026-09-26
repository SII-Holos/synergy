import { expect, test } from "bun:test"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Ide } from "../../src/project/ide"

test.each(["Visual Studio Code", "Visual Studio Code - Insiders", "Cursor", "VSCodium", "Windsurf"])(
  "detects %s from its terminal environment",
  async (name) => {
    await using fixture = await runtimeHome()
    const owner = RuntimeContext.create({
      ...fixture.host,
      env: {
        ...fixture.host.env,
        TERM_PROGRAM: "vscode",
        GIT_ASKPASS: `/Applications/${name}.app/Contents/Resources/app/extensions/git/dist/askpass.sh`,
      },
    })
    try {
      expect(owner.run(() => Ide.ide())).toBe(name)
    } finally {
      owner.dispose()
    }
  },
)

test.each([
  ["iTerm2", "/Applications/Visual Studio Code - Insiders.app/askpass.sh", "unknown", false],
  ["vscode", "/path/to/unknown/askpass.sh", "unknown", false],
  [undefined, undefined, "vscode-insiders", true],
  [undefined, undefined, "vscode", true],
] as const)("resolves terminal %s and caller %s independently", async (terminal, askpass, caller, installed) => {
  await using fixture = await runtimeHome()
  const owner = RuntimeContext.create({
    ...fixture.host,
    env: { ...fixture.host.env, TERM_PROGRAM: terminal, GIT_ASKPASS: askpass, SYNERGY_CALLER: caller },
  })
  try {
    owner.run(() => {
      expect(Ide.ide()).toBe("unknown")
      expect(Ide.alreadyInstalled()).toBe(installed)
    })
  } finally {
    owner.dispose()
  }
})
