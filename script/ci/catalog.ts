import path from "node:path"
import { execFileSync } from "node:child_process"
import { loadManifest } from "../coverage-check"
import { collectTests } from "../../packages/testing/script/batches"
import { type Task, type WorkspaceInput } from "./plan"
import { workspaces } from "../workspace-manifest"

export const ROOT = path.resolve(import.meta.dir, "../..")
export const OUTPUT = ".artifacts/ci"

function git(root: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd: root, input, maxBuffer: 128 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })
}

export function revisionFiles(root: string, revision: string, names: string[]): Map<string, string> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("CI revisions must be full commit SHAs")
  const output = git(root, ["cat-file", "--batch"], names.map((name) => `${revision}:${name}\n`).join(""))
  const result = new Map<string, string>()
  let offset = 0
  for (const name of names) {
    const end = output.indexOf(10, offset)
    const header = output.subarray(offset, end).toString()
    offset = end + 1
    if (header.endsWith(" missing")) continue
    const size = Number(header.split(" ").at(-1))
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Git object response")
    result.set(name, output.subarray(offset, offset + size).toString())
    offset += size + 1
  }
  return result
}

export async function workspaceInputs(root: string, revision: string): Promise<WorkspaceInput[]> {
  const { imports } = await import("../workspace-dependencies")
  const rootManifest = JSON.parse(revisionFiles(root, revision, ["package.json"]).get("package.json")!) as {
    workspaces: { packages: string[] }
  }
  const files = git(root, ["ls-tree", "-r", "--name-only", revision]).toString().trim().split("\n")
  const manifests = revisionFiles(
    root,
    revision,
    rootManifest.workspaces.packages.map((directory) => `${directory}/package.json`),
  )
  const packages = rootManifest.workspaces.packages.map((directory) => {
    const manifest = JSON.parse(manifests.get(`${directory}/package.json`)!) as {
      name: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return {
      directory,
      name: manifest.name,
      dependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
      testDependencies: Object.keys(manifest.devDependencies ?? {}),
    }
  })
  const byName = new Map(packages.map((entry) => [entry.name, entry]))
  const owner = (file: string) => packages.find((entry) => file.startsWith(entry.directory + "/"))
  const testFiles = files.filter((file) => /\/(?:test|script|src)\/.*\.[cm]?[jt]sx?$/.test(file) && owner(file))
  for (const [file, source] of revisionFiles(root, revision, testFiles)) {
    const from = owner(file)!
    for (const specifier of imports(file, source)) {
      const dependency = specifier.startsWith(".")
        ? owner(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
        : byName.get(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!)
      if (dependency && dependency !== from) from.testDependencies.push(dependency.name)
    }
  }
  // Desktop embeds the Web host and launches the product runtime without a workspace import.
  const desktop = packages.find((entry) => entry.directory === "apps/desktop")
  if (desktop)
    for (const directory of [
      "apps/web",
      "packages/product-runtime",
      "packages/browser-runtime",
      "packages/computer-protocol",
    ]) {
      const dependency = packages.find((entry) => entry.directory === directory)
      if (dependency) desktop.testDependencies.push(dependency.name)
    }
  return packages.map((entry) => ({
    ...entry,
    dependencies: entry.dependencies.filter((name) => byName.has(name)),
    testDependencies: [...new Set(entry.testDependencies)].filter((name) => byName.has(name)).sort(),
  }))
}

export function changedFiles(root: string, base: string, head: string): string[] {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("CI requires exact base and head revisions")
  // --no-renames includes both the removed and added ownership paths.
  return git(root, ["diff", "--name-only", "--no-renames", "-z", base, head])
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort()
}

export async function catalog(root = ROOT): Promise<Task[]> {
  const manifest = await loadManifest(root)
  const packages = workspaces(root)
  const coverage = new Set(Object.keys(manifest.packages))
  for (const { directory } of packages) {
    if (directory === "benchmark") continue
    if (!coverage.has(directory)) throw new Error(`Workspace has no CI coverage owner: ${directory}`)
  }
  for (const directory of coverage)
    if (!packages.some((entry) => entry.directory === directory))
      throw new Error(`Unknown coverage workspace: ${directory}`)
  const task = (
    id: string,
    kind: Task["kind"],
    seconds: number,
    owners: string[] = [],
    extra: Partial<Task> = {},
  ): Task => ({ id, kind, seconds, pool: "linux", owners, needs: [], ...extra })
  const tasks: Task[] = [
    task("policy", "policy", 45, [], { files: ["test/script/oryn-validation.test.ts"] }),
    task("static", "static", 60),
    task("root-tests", "static", 90, [], { variant: "tests" }),
    task("typecheck", "typecheck", 100),
    task("packages", "packages", 45, [...coverage]),
    task("installed-runtime", "artifacts", 400, ["packages/cli", "packages/product-runtime"], {
      files: ["test/script/watcher-native.test.ts"],
      prerequisites: ["sandbox"],
    }),
    task(
      "web-integration",
      "web",
      170,
      ["apps/web", "packages/ui", "packages/plugin", "packages/plugin-kit", "packages/sdk/js"],
      { prerequisites: ["browser"] },
    ),
    task("desktop", "desktop", 180, ["apps/desktop"], { prerequisites: ["desktop"] }),
    task("smoke", "smoke", 40, ["packages/product-runtime", "packages/server"]),
    task("sandbox", "sandbox", 100, ["packages/local-runtime"], { prerequisites: ["sandbox"] }),
    task(
      "windows",
      "windows",
      450,
      ["apps/desktop", "packages/cli", "packages/harness", "packages/local-runtime", "packages/util"],
      {
        pool: "windows",
        package: "packages/local-runtime",
        needs: ["suite-packages-local-runtime"],
      },
    ),
    task("macos-workspace", "native-workspace", 300, ["packages/local-runtime", "packages/agent-integrations"], {
      pool: "macos",
      package: "packages/local-runtime",
      needs: ["suite-packages-local-runtime"],
    }),
    ...[16, 17, 18].map((version) =>
      task(`postgres-${version}`, "postgres", 180, ["packages/harness"], {
        pool: "postgres",
        variant: String(version),
      }),
    ),
    task("benchmark-pure", "benchmark-pure", 80, ["benchmark"]),
    task("benchmark-streams", "benchmark-streams", 70, ["benchmark"], {
      files: ["benchmark/test/test_gateway.py", "benchmark/test/test_gateway_faults.py"],
    }),
    task("benchmark-prepare", "benchmark-prepare", 150, [], { pool: "docker" }),
    ...["normal", "faults"].map((variant) =>
      task(
        `benchmark-docker-${variant}`,
        "benchmark-docker",
        600,
        ["benchmark", "packages/harness", "packages/local-runtime"],
        {
          pool: "docker",
          variant,
          needs: ["benchmark-prepare"],
          files: (variant === "normal"
            ? ["test_docker.py", "test_native.py", "test_compaction_docker.py", "test_oracle.py"]
            : ["test_docker.py", "test_recovery.py", "test_parent_death_docker.py", "test_oom_docker.py"]
          ).map((file) => `benchmark/test/${file}`),
        },
      ),
    ),
    ...["synergy", "codex", "opencode", "pi", "deepseek"].map((variant) =>
      task(`native-${variant}`, "benchmark-native", variant === "synergy" ? 580 : 330, [], {
        pool: "docker",
        variant,
        files: ["benchmark/test/test_matrix_docker.py"],
        needs: variant === "synergy" ? ["benchmark-prepare"] : [],
      }),
    ),
    ...["completed", "cancelled", "failed"].map((variant) =>
      task(`rollout-${variant}`, "rollout", 320, ["packages/harness"], { variant }),
    ),
  ]
  const specialized = new Set(tasks.flatMap((task) => task.files ?? []))
  tasks.find((task) => task.id === "root-tests")!.files = (await collectTests("test/script", root))
    .filter((file) => !specialized.has(file))
    .sort()
  const weights: Record<string, number> = {
    "packages/product-runtime": 360,
    "apps/web": 220,
    "packages/connections": 180,
    "packages/ui": 160,
    "packages/local-runtime": 150,
    "packages/library": 130,
  }
  for (const directory of [...coverage].sort()) {
    const workspace = packages.find((entry) => entry.directory === directory)!
    const dependencies = { ...workspace.dependencies, ...workspace.devDependencies }
    const browser = ["playwright", "playwright-core", "@playwright/test"].some((name) => name in dependencies)
    const files = (await collectTests("test", path.join(root, directory))).sort()
    if (!files.length) throw new Error(`Workspace has no discovered tests: ${directory}`)
    const name = directory.replaceAll("/", "-")
    const partitions = directory === "packages/harness" ? [0, 1, 2, 3] : [undefined]
    for (const partition of partitions)
      tasks.push(
        task(
          `suite-${name}${partition === undefined ? "" : `-${partition}`}`,
          "suite",
          directory === "packages/harness" ? 200 : (weights[directory] ?? 45),
          [directory],
          {
            package: directory,
            partition,
            files,
            assets: ["watcher", "plugin"],
            prerequisites: browser ? ["browser"] : [],
          },
        ),
      )
  }
  for (const entry of tasks) {
    entry.isolation =
      entry.kind === "suite"
        ? "batch-home"
        : entry.pool === "docker"
          ? "container"
          : entry.pool === "postgres"
            ? "database"
            : "task-home"
    entry.outputs =
      entry.kind === "native-workspace" || entry.kind === "windows"
        ? ["junit", "lcov"]
        : entry.kind === "suite"
          ? ["junit", "lcov", "timing"]
          : [
                "policy",
                "artifacts",
                "desktop",
                "sandbox",
                "postgres",
                "rollout",
                "web",
                "benchmark-pure",
                "benchmark-streams",
                "benchmark-docker",
                "benchmark-native",
              ].includes(entry.kind) || entry.variant === "tests"
            ? ["junit"]
            : []
    if (entry.kind === "benchmark-pure")
      entry.files = Array.from(new Bun.Glob("benchmark/test/test_*.py").scanSync({ cwd: root }))
        .filter((file) => !tasks.some((task) => task.kind === "benchmark-streams" && task.files?.includes(file)))
        .sort()
  }
  return tasks
}
