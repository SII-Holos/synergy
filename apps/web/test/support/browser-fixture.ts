import { readdir, realpath } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { cachedFixture } from "./fixture-cache"

const repository = path.resolve(import.meta.dir, "../../../..")
type Alias = { find: string | RegExp; replacement: string }
type Recipe = {
  root: string
  entries: string[]
  styled: boolean
  localized: boolean
  aliases: Array<{ find: string | { source: string; flags: string }; replacement: string }>
}

export async function browserFixtureInput(recipe: Recipe, repositoryPath = repository) {
  const repositoryRoot = await realpath(repositoryPath)
  const normalize = (value: string) =>
    value.replaceAll(recipe.root, "$fixture").replaceAll(repositoryRoot, "$repository")
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(`${process.platform}/${process.arch}/${Bun.version}\0${normalize(JSON.stringify(recipe))}`)
  async function add(file: string, name = path.relative(repositoryRoot, file)) {
    hash.update(`\0${name}\0`)
    const bytes = await Bun.file(file).arrayBuffer()
    hash.update(/\.(?:[cm]?[jt]sx?|json|html|css|po)$/.test(file) ? normalize(new TextDecoder().decode(bytes)) : bytes)
  }
  async function tree(directory: string, prefix: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      const name = path.posix.join(prefix, entry.name)
      if (entry.isDirectory()) await tree(file, name)
      else {
        if (entry.isSymbolicLink()) {
          const target = await realpath(file)
          const relative = path.relative(repositoryRoot, target)
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`External fixture input: ${name}`)
          hash.update(`\0${name}->${relative}\0`)
        }
        await add(file, name)
      }
    }
  }
  const manifest = (await Bun.file(path.join(repositoryRoot, "package.json")).json()) as {
    workspaces: { packages: string[] }
  }
  const packages = await Promise.all(
    manifest.workspaces.packages.map(async (directory) => ({
      directory,
      manifest: (await Bun.file(path.join(repositoryRoot, directory, "package.json")).json()) as {
        name: string
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      },
    })),
  )
  const selected = new Set(["apps/web"])
  for (const directory of selected) {
    const pkg = packages.find((pkg) => pkg.directory === directory)!
    for (const [name, version] of Object.entries({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies })) {
      if (!version.startsWith("workspace:")) continue
      const dependency = packages.find((pkg) => pkg.manifest.name === name)
      if (!dependency) throw new Error(`Unknown fixture workspace: ${name}`)
      selected.add(dependency.directory)
    }
  }
  const contains = (directory: string, file: string) => {
    const relative = path.relative(directory, file)
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  }
  const allowed = [
    await realpath(recipe.root),
    ...[...selected].flatMap((directory) => [
      path.join(repositoryRoot, directory, "src"),
      ...(directory === "apps/web" ? [] : [path.join(repositoryRoot, directory, "dist")]),
    ]),
  ]
  for (const alias of recipe.aliases) {
    if (!path.isAbsolute(alias.replacement)) throw new Error(`Untracked fixture alias: ${alias.replacement}`)
    const target = await realpath(alias.replacement)
    if (!allowed.some((directory) => contains(directory, target)))
      throw new Error(`Untracked fixture alias: ${alias.replacement}`)
  }
  for (const directory of [...selected].sort()) {
    await add(path.join(repositoryRoot, directory, "package.json"))
    for (const filename of (await readdir(path.join(repositoryRoot, directory))).sort())
      if (/^tsconfig.*\.json$/.test(filename)) await add(path.join(repositoryRoot, directory, filename))
    await tree(path.join(repositoryRoot, directory, "src"), `${directory}/src`)
    if (directory !== "apps/web") await tree(path.join(repositoryRoot, directory, "dist"), `${directory}/dist`)
  }
  for (const file of [
    "package.json",
    "bun.lock",
    "apps/web/lingui.config.ts",
    "apps/web/index.html",
    "apps/web/test/support/browser-fixture.ts",
    "apps/web/test/support/fixture-cache.ts",
  ])
    await add(path.join(repositoryRoot, file))
  await tree(path.join(repositoryRoot, "apps/web/test/fixtures"), "fixtures")
  await tree(recipe.root, "fixture")
  return hash.digest("hex")
}

export type BrowserFixture = Awaited<ReturnType<typeof createBrowserFixture>>

export async function createBrowserFixture(options: {
  root: string
  aliases?: Alias[]
  entries?: string[]
  styled?: boolean
  localized?: boolean
}) {
  const root = await realpath(options.root)
  const recipe: Recipe = {
    root,
    entries: options.entries ?? ["index.html"],
    styled: options.styled ?? false,
    localized: options.localized ?? options.styled ?? false,
    aliases: (options.aliases ?? []).map(({ find, replacement }) => ({
      find: typeof find === "string" ? find : { source: find.source, flags: find.flags },
      replacement: replacement.replaceAll(options.root, root),
    })),
  }
  const input = await browserFixtureInput(recipe)
  const directory = await cachedFixture({
    cache: path.join(repository, ".artifacts/testing/web-dom-fixtures"),
    input,
    async build(directory) {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" }
      delete env.GH_TOKEN
      delete env.GITHUB_TOKEN
      delete env.SYNERGY_TEST_FILES
      const builder = Bun.spawn([process.execPath, import.meta.filename], {
        env,
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      })
      builder.stdin.write(JSON.stringify({ ...recipe, output: directory }))
      await builder.stdin.end()
      if (await builder.exited) throw new Error("Browser fixture compilation failed")
      if ((await browserFixtureInput(recipe)) !== input)
        throw new Error("Browser fixture inputs changed during compilation")
    },
  })
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://fixture.test").pathname)
      const filename = path.resolve(directory, `.${pathname === "/" ? "/index.html" : pathname}`)
      if (path.relative(directory, filename).startsWith("..")) {
        response.writeHead(404).end()
        return
      }
      let file = Bun.file(filename)
      if (!(await file.exists()) && !path.extname(pathname)) file = Bun.file(path.join(directory, "index.html"))
      if (!(await file.exists())) {
        response.writeHead(404).end()
        return
      }
      response.setHeader("Content-Type", file.type)
      response.end(Buffer.from(await file.arrayBuffer()))
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    directory,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

if (import.meta.main) {
  const recipe = JSON.parse(await Bun.stdin.text()) as Recipe & { output: string }
  const [{ build }, { default: solidPlugin }, { default: tailwindcss }, { lingui }] = await Promise.all([
    import("vite"),
    import("vite-plugin-solid"),
    import("@tailwindcss/vite"),
    import("@lingui/vite-plugin"),
  ])
  await build({
    configFile: false,
    logLevel: "error",
    mode: "test",
    root: recipe.root,
    publicDir: false,
    define: { "process.env.NODE_ENV": JSON.stringify("test") },
    plugins: [
      { name: "fixture-files", resolveId: (id) => (id.startsWith("/@fs/") ? id.slice(4) : undefined) },
      solidPlugin(),
      ...(recipe.styled ? [tailwindcss()] : []),
      ...(recipe.localized ? lingui() : []),
    ],
    resolve: {
      conditions: ["module", "browser", "development"],
      alias: recipe.aliases.map(({ find, replacement }) => ({
        find: typeof find === "string" ? find : new RegExp(find.source, find.flags),
        replacement,
      })),
    },
    worker: { format: "es" },
    build: {
      outDir: recipe.output,
      emptyOutDir: true,
      target: "esnext",
      minify: false,
      cssMinify: false,
      rollupOptions: { input: recipe.entries.map((entry) => path.join(recipe.root, entry)) },
    },
  })
  process.exit(0)
}
