import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { browserFixtureInput } from "../support/browser-fixture"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "web-fixture-input-"))
  directories.push(directory)
  const repository = path.join(directory, "repository")
  const root = path.join(directory, "fixture")
  const files = {
    "package.json": JSON.stringify({ workspaces: { packages: ["apps/web", "packages/util"] } }),
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { util: "workspace:*" } }),
    "packages/util/package.json": JSON.stringify({ name: "util" }),
    "apps/web/lingui.config.ts": "export default { locale: 'en' }",
    "apps/web/index.html": '<main class="fixture-style"></main>',
    "apps/web/src/component.tsx": "export const component = 'initial'",
    "packages/util/src/index.ts": "export const value = 'source'",
    "packages/util/dist/index.js": "export const value = 'built'",
    "apps/web/test/support/browser-fixture.ts": "fixture builder version",
    "apps/web/test/support/fixture-cache.ts": "cache version",
    "bun.lock": "lock version",
  }
  for (const [name, contents] of Object.entries(files)) await Bun.write(path.join(repository, name), contents)
  await Bun.write(path.join(root, "index.html"), '<script type="module" src="/main.js"></script>')
  await Bun.write(path.join(root, "stub.js"), "export default 'fixture value'")
  const recipe = {
    root,
    entries: ["index.html"],
    aliases: [] as Array<{ find: string; replacement: string }>,
    styled: true,
    localized: true,
  }
  return { directory, repository, root, recipe, input: () => browserFixtureInput(recipe, repository) }
}

test("fixture identity tracks Lingui configuration, HTML style sources and transitive built dependencies", async () => {
  const f = await fixture()
  let previous = await f.input()
  for (const filename of [
    "apps/web/lingui.config.ts",
    "apps/web/index.html",
    "apps/web/src/component.tsx",
    "packages/util/dist/index.js",
    "bun.lock",
  ]) {
    await Bun.write(path.join(f.repository, filename), `changed ${filename}`)
    const current = await f.input()
    expect(current).not.toBe(previous)
    previous = current
  }
})

test("alias targets must belong to a hashed fixture or workspace source and build tree", async () => {
  const f = await fixture()
  for (const replacement of [
    path.join(f.root, "stub.js"),
    path.join(f.repository, "apps/web/src"),
    path.join(f.repository, "packages/util/dist/index.js"),
  ]) {
    f.recipe.aliases = [{ find: "fixture-value", replacement }]
    expect(await f.input()).toMatch(/^[a-f0-9]{64}$/)
  }
  const external = path.join(f.directory, "external.js")
  await Bun.write(external, "export default 'untracked'")
  const untracked = path.join(f.repository, "untracked.js")
  await Bun.write(untracked, "export default 'also untracked'")
  for (const replacement of [external, untracked, "external-package"]) {
    f.recipe.aliases = [{ find: "fixture-value", replacement }]
    await expect(f.input()).rejects.toThrow("Untracked fixture alias")
  }
  const linked = path.join(f.root, "linked.js")
  await symlink(external, linked)
  f.recipe.aliases = [{ find: "fixture-value", replacement: linked }]
  await expect(f.input()).rejects.toThrow("Untracked fixture alias")
})
