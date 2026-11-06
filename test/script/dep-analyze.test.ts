import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { imports, validateWorkspaces } from "../../script/workspace-dependencies"

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-package-boundaries-"))
  const names = ["harness", "util", "browser-runtime"]
  await mkdir(path.join(root, "script"))
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: { packages: names.map((name) => `packages/${name}`) } }),
  )
  await Bun.write(
    path.join(root, "script/dependency-rules.json"),
    JSON.stringify({ "packages/harness": ["packages/util"] }),
  )
  for (const name of names) {
    await mkdir(path.join(root, "packages", name, "src"), { recursive: true })
    await Bun.write(
      path.join(root, "packages", name, "package.json"),
      JSON.stringify({
        name,
        exports: { ".": "./src/index.ts" },
        dependencies: name === "harness" ? { util: "workspace:*" } : {},
      }),
    )
    await Bun.write(path.join(root, "packages", name, "src/index.ts"), "export const value = 1\n")
  }
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("imports distinguish prose from static, dynamic and type-only dependencies", () => {
  expect(
    imports(
      "index.ts",
      `import type { A } from "a"; export { B } from "b"; await import("c"); const description = "d"`,
    ),
  ).toEqual(["a", "b", "c"])
})

test("public imports with declared dependencies form a valid isolated package", async () => {
  await fixture(async (root) => {
    await Bun.write(path.join(root, "packages/harness/src/index.ts"), 'import { value } from "util"\nexport { value }')
    expect(validateWorkspaces(root).failures).toEqual([])
  })
})

test("declaring a dependency does not authorize a private source import", async () => {
  await fixture(async (root) => {
    await Bun.write(path.join(root, "packages/harness/src/index.ts"), 'export { value } from "../../util/src/index"')
    expect(validateWorkspaces(root).failures).toEqual([
      "packages/harness/src/index.ts: private cross-package import ../../util/src/index",
    ])
  })
})

test("unregistered public exports and undeclared dependencies fail independently", async () => {
  await fixture(async (root) => {
    await Bun.write(path.join(root, "packages/harness/src/index.ts"), 'import "browser-runtime/private"')
    expect(validateWorkspaces(root).failures).toEqual([
      "packages/harness/src/index.ts: undeclared production dependency browser-runtime",
      "packages/harness/src/index.ts: undeclared export browser-runtime/private",
    ])
  })
})

test("manifest cycles are detected even when source files do not import each other", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "packages/util/package.json")
    const pkg = await Bun.file(file).json()
    pkg.dependencies.harness = "workspace:*"
    await Bun.write(file, JSON.stringify(pkg))
    expect(
      validateWorkspaces(root).failures.some((failure) => failure.startsWith("Production dependency cycle:")),
    ).toBe(true)
  })
})

test("runtime resolution and literal worker URLs enforce the same workspace boundary", async () => {
  await fixture(async (root) => {
    await Bun.write(
      path.join(root, "packages/harness/src/index.ts"),
      `import.meta.resolve("browser-runtime/private"); new URL("../../util/src/index.ts", import.meta.url)`,
    )
    expect(validateWorkspaces(root).failures).toEqual([
      "packages/harness/src/index.ts: undeclared production dependency browser-runtime",
      "packages/harness/src/index.ts: undeclared export browser-runtime/private",
      "packages/harness/src/index.ts: private cross-package import ../../util/src/index.ts",
    ])
  })
})

test("white-box testing exports cannot become production dependencies", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "packages/util/package.json")
    const manifest = await Bun.file(file).json()
    manifest.exports["./test/internal"] = "./src/index.ts"
    await Bun.write(file, JSON.stringify(manifest))
    await Bun.write(path.join(root, "packages/harness/src/index.ts"), 'import "util/test/internal"')
    expect(validateWorkspaces(root).failures).toEqual([
      "packages/harness/src/index.ts: production source imports testing-only export util/test/internal",
    ])
  })
})

test("type queries and module augmentation remain explicit package contracts", () => {
  expect(
    imports(
      "config.ts",
      'type Host = import("host/private").Host; declare module "harness/config/schema" { interface Extensions { enabled: boolean } }',
    ),
  ).toEqual(["host/private", "harness/config/schema"])
})
