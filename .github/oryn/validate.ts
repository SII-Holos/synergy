import path from "node:path"

export type Workspace = { path: string; name: string; dependencies: string[] }

export function validationEnv(
  home: string,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    PATH: inherited.PATH ?? "/usr/bin:/bin",
    LANG: inherited.LANG ?? "C.UTF-8",
    HOME: home,
    SYNERGY_HOME: home,
    SYNERGY_TEST_HOME: path.join(home, "test-home"),
    SYNERGY_TEST_ROOT: path.join(home, "test-fixtures"),
    SYNERGY_LINK_HOME: path.join(home, "link-home"),
    SYNERGY_DISABLE_MODELS_FETCH: "1",
    SYNERGY_DISABLE_AUTOUPDATE: "1",
    PLAYWRIGHT_BROWSERS_PATH: "/opt/oryn-browsers",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Oryn validation",
    GIT_AUTHOR_EMAIL: "oryn-mini@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Oryn validation",
    GIT_COMMITTER_EMAIL: "oryn-mini@users.noreply.github.com",
    CI: "1",
  }
}

async function output(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`${args[0]} exited ${code}: ${stderr.slice(-4000)}`)
  return stdout
}

export async function changedFiles(directory: string, base: string, env: Record<string, string>) {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Validation requires an exact base commit")
  const values = await Promise.all([
    output(["git", "diff", "--name-only", "-z", base, "--"], directory, env),
    output(["git", "ls-files", "--others", "--exclude-standard", "-z"], directory, env),
  ])
  return [...new Set(values.flatMap((value) => value.split("\0").filter(Boolean)))].sort()
}

export function selectValidation(files: string[], graph: Workspace[]) {
  const selected = new Set<string>()
  for (const file of files) {
    if (
      /^(?:docs\/.*\.md|(?:README|AGENTS|CONTRIBUTING|CODE_OF_CONDUCT)\.md|\.synergy\/(?:skill|command)\/.*\.md)$/.test(
        file,
      )
    )
      continue
    const owner = graph.find((workspace) => file.startsWith(workspace.path + "/"))
    if (owner && /\/(?:README|AGENTS)\.md$/.test(file)) continue
    if (owner) selected.add(owner.name)
    else for (const workspace of graph) selected.add(workspace.name)
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const workspace of graph) {
      if (selected.has(workspace.name) || !workspace.dependencies.some((name) => selected.has(name))) continue
      selected.add(workspace.name)
      changed = true
    }
  }
  const packages = [...selected].sort()
  const filters = packages.map((name) => `--filter=${name}`)
  const checks = [
    ["git", "diff", "--check"],
    ["git", "diff", "--cached", "--check"],
    ...["doc:check", "decision:check", "skill:check"].map((gate) => ["bun", "run", gate]),
  ]
  if (packages.length) checks.push(["bun", "turbo", "typecheck", "--concurrency=2", "--env-mode=loose", ...filters])
  return {
    packages,
    prepare: [
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      ...(packages.length
        ? [["bun", "turbo", "build", "--filter=@ericsanchezok/synergy-plugin", "--env-mode=loose"]]
        : []),
    ],
    checks,
    tests: packages.length ? [["bun", "turbo", "test", "--concurrency=2", "--env-mode=loose", ...filters]] : [],
  }
}

async function snapshot(directory: string): Promise<Workspace[]> {
  const manifest = await Bun.file(path.join(directory, "package.json")).json()
  const directories: string[] = manifest.workspaces.packages
  const packages = await Promise.all(
    directories.map(async (directory) => ({
      path: directory,
      manifest: await Bun.file(path.join(directory, "package.json")).json(),
    })),
  )
  const names = new Set(packages.map((pkg) => pkg.manifest.name as string))
  return packages.map((pkg) => ({
    path: pkg.path,
    name: pkg.manifest.name as string,
    dependencies: Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
      ...pkg.manifest.peerDependencies,
    }).filter((name) => names.has(name)),
  }))
}

if (import.meta.main) {
  const phase = process.argv[2]
  if (phase === "snapshot") console.log(JSON.stringify(await snapshot(process.cwd())))
  else {
    if (phase !== "prepare" && phase !== "checks" && phase !== "tests") throw new Error("Unknown validation phase")
    if (!process.env.HOME || process.env.HOME !== process.env.SYNERGY_HOME)
      throw new Error("Validation requires its isolated home")
    const graph: Workspace[] = await Bun.file(path.join(import.meta.dir, "workspaces.json")).json()
    const base = (await Bun.file(path.join(import.meta.dir, "base-sha")).text()).trim()
    const env = validationEnv(process.env.HOME)
    const plan = selectValidation(await changedFiles(process.cwd(), base, env), graph)
    console.log(JSON.stringify({ phase, packages: plan.packages, commands: plan[phase] }))
    for (const args of plan[phase]) {
      const child = Bun.spawn(args, { cwd: process.cwd(), env, stdout: "inherit", stderr: "inherit" })
      const code = await child.exited
      if (code) throw new Error(`Validation command exited ${code}: ${args.join(" ")}`)
    }
  }
}
