import { POSTGRES_TEST_FILES } from "../../packages/harness/test/support/storage-backends"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { loadManifest } from "../coverage-check"
import { collectTests } from "../../packages/testing/script/batches"
import { type Task, type WorkspaceInput } from "./plan"
import { workspaces } from "../workspace-manifest"
import { partitionSuite } from "./suites"
export { changedFiles } from "./selection"

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
  // Desktop embeds the Web host and launches the preset runtime without a workspace import.
  const desktop = packages.find((entry) => entry.directory === "apps/desktop")
  if (desktop)
    for (const directory of [
      "apps/web",
      "packages/presets",
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
    ...[
      {
        id: "installed-core-binary",
        profile: "core" as const,
        variant: "binary",
        seconds: 60,
        scenarios: ["tool"],
        files: ["test/script/watcher-native.test.ts"],
      },
      {
        id: "installed-core-package",
        profile: "core" as const,
        variant: "package",
        seconds: 120,
        scenarios: ["complete"],
      },
      {
        id: "installed-full-behavior-a",
        profile: "full" as const,
        variant: "binary",
        seconds: 450,
        scenarios: ["complete"],
      },
      {
        id: "installed-full-behavior-b",
        profile: "full" as const,
        variant: "binary",
        seconds: 360,
        scenarios: ["tool", "budget"],
      },
      {
        id: "installed-full-behavior-c",
        profile: "full" as const,
        variant: "binary",
        seconds: 150,
        scenarios: ["read", "timeout", "permission"],
      },
      {
        id: "installed-full-composition",
        profile: "full" as const,
        variant: "composition",
        seconds: 480,
        scenarios: [],
      },
      ...["components", "web"].map((variant) => ({
        id: `installed-full-${variant}`,
        profile: "full" as const,
        variant,
        seconds: variant === "components" ? 190 : 130,
        scenarios: [],
      })),
    ].map((entry) =>
      task(entry.id, "artifacts", entry.seconds, ["packages/cli", "packages/presets"], {
        ...entry,
        prerequisites: ["sandbox"],
        scenarios: entry.scenarios.length
          ? entry.scenarios.map(
              (scenario) => `installed runtime artifact preserves ${scenario} outcome outside the repository`,
            )
          : undefined,
        scenarioPrefix: "installed runtime artifact preserves ",
        outputs: entry.scenarios.length ? ["junit"] : [],
      }),
    ),
    task(
      "web-integration",
      "web",
      170,
      ["apps/web", "packages/ui", "packages/plugin", "packages/plugin-kit", "packages/sdk/js"],
      { prerequisites: ["browser"], profile: "full", files: ["apps/web/test/app-build-css-contract.test.ts"] },
    ),
    task("desktop", "desktop", 180, ["apps/desktop"], { prerequisites: ["desktop"] }),
    task("smoke", "smoke", 40, ["packages/presets", "packages/server"]),
    task("sandbox", "sandbox", 100, ["packages/local-runtime"], { prerequisites: ["sandbox"] }),
    task(
      "execution-environment",
      "environment",
      300,
      ["packages/harness", "packages/local-runtime", "packages/server"],
      {
        pool: "docker",
        scenarios: [
          "a deleted Docker allocation marks its live view unavailable while retaining saved files and staging",
          "Docker compute starts on demand, preserves output and runs commands without host credentials",
          "Docker Workspace checkpoints survive upload failure and replacement of the entire allocation",
          "session terminals and user shell share the selected Docker Environment and recoverable Workspace",
          "restarting the controller saves an existing Docker result without executing it again",
          "configured Docker and local objects survive compute reclamation through the product composition",
          "remote Docker Engine and execution endpoints share the lifecycle over authenticated TLS",
        ],
      },
    ),
    task(
      "windows-native",
      "windows",
      450,
      ["apps/desktop", "packages/cli", "packages/harness", "packages/local-runtime", "packages/util"],
      {
        pool: "windows",
        variant: "native",
        package: "packages/local-runtime",
        needs: ["suite-packages-local-runtime"],
      },
    ),
    task("windows-desktop", "windows", 120, ["apps/desktop"], {
      pool: "windows",
      variant: "desktop",
      outputs: ["junit"],
    }),
    task("macos-workspace", "native-workspace", 300, ["packages/local-runtime", "packages/lsp", "packages/formatter"], {
      pool: "macos",
      package: "packages/local-runtime",
      needs: ["suite-packages-local-runtime"],
    }),
    ...[16, 17, 18].map((version) =>
      task(`postgres-${version}`, "postgres", 180, ["packages/harness"], {
        pool: "postgres",
        variant: String(version),
        files: [...POSTGRES_TEST_FILES],
        inputs: [
          ...POSTGRES_TEST_FILES.map((file) => `packages/harness/${file}`),
          "packages/harness/test/support/preload.ts",
        ],
      }),
    ),
    task("benchmark-pure", "benchmark-pure", 80, ["benchmark"]),
    task("benchmark-streams", "benchmark-streams", 70, ["benchmark"], {
      files: ["benchmark/test/test_gateway.py", "benchmark/test/test_gateway_faults.py"],
    }),
    task("benchmark-prepare", "benchmark-prepare", 150, [], { pool: "docker" }),
    ...[
      {
        id: "admission",
        file: "test_docker.py",
        selection: "test_admission",
        seconds: 60,
        scenarios: ["ordinary", "none", "restricted"].map(
          (id) => `test_admission_preserves_native_network_topology_and_removes_only_owned_resources[${id}]`,
        ),
      },
      {
        id: "paired",
        file: "test_docker.py",
        selection: "test_real_synergy_paired_rollout",
        prepared: true,
        seconds: 180,
        scenarios: ["test_real_synergy_paired_rollout"],
      },
      {
        id: "bindings",
        file: "test_native.py",
        prepared: true,
        seconds: 100,
        scenarios: [
          "test_prepared_source_runs_owned_processes_without_a_runtime_compiler",
          "test_compiled_watcher_survives_a_real_interrupted_poll",
        ],
      },
      {
        id: "pi-compaction",
        file: "test_compaction_docker.py",
        seconds: 120,
        scenarios: ["test_native_pi_compaction_is_included_in_per_request_accounting"],
      },
      {
        id: "oracle",
        file: "test_oracle.py",
        selection: "test_native_oracle",
        seconds: 90,
        scenarios: [
          "test_native_oracle_and_verifier_outlive_upstream_short_deadlines",
          "test_native_oracle_timeout_still_runs_verifier",
        ],
      },
      {
        id: "recovery",
        file: "test_recovery.py",
        selection: "not test_export_recovery",
        seconds: 60,
        scenarios: [
          ...[0, 7].map((code) => `test_recovery_hands_private_files_back_without_changing_original[${code}]`),
          ...["False", "True"].map(
            (stopped) => `test_orphaned_logs_handoff_preserves_private_modes_and_bytes[${stopped}]`,
          ),
        ],
      },
      {
        id: "parent-death",
        file: "test_parent_death_docker.py",
        seconds: 60,
        scenarios: ["test_parent_death_preserves_dispatched_cost_and_never_repeats_terminal_task"],
      },
      {
        id: "oom",
        file: "test_oom_docker.py",
        seconds: 80,
        scenarios: [
          "test_native_docker_working_set_is_observed",
          "test_kernel_oom_is_retained_after_container_removal",
        ],
      },
      ...["long", "disconnect", "timeout", "cancel", "docker-stop"].map((fault) => ({
        id: `fault-${fault}`,
        file: "test_docker.py",
        prepared: true,
        seconds: fault === "long" ? 180 : 100,
        selection: `test_faults_preserve_terminal_evidence_and_cleanup and ${fault}`,
        scenarios: [`test_faults_preserve_terminal_evidence_and_cleanup[${fault}]`],
      })),
    ].map((entry) =>
      task(
        `benchmark-docker-${entry.id}`,
        "benchmark-docker",
        entry.seconds,
        ["benchmark", "packages/harness", "packages/local-runtime"],
        {
          pool: "docker",
          selection: entry.selection,
          scenarios: entry.scenarios,
          scenarioPrefix: "test_",
          needs: entry.prepared ? ["benchmark-prepare"] : [],
          files: [`benchmark/test/${entry.file}`],
        },
      ),
    ),
    ...["synergy", "codex", "opencode", "pi", "deepseek"].map((variant) =>
      task(`native-${variant}`, "benchmark-native", 180, [], {
        pool: "docker",
        variant,
        selection: "test_native_matrix",
        files: ["benchmark/test/test_matrix_docker.py"],
        scenarios: ["chat-completions", "responses"].map(
          (protocol) => `test_native_matrix_preserves_protocol_and_adapter_behavior[${protocol}]`,
        ),
        scenarioPrefix: "test_native_matrix_",
        needs: variant === "synergy" ? ["benchmark-prepare"] : [],
      }),
    ),
    ...[
      {
        id: "task-home",
        selection: "test_synergy_preserves_task_home",
        seconds: 180,
        scenarios: ["tool-roundtrip", "empty-provider-stop"].map(
          (id) => `test_synergy_preserves_task_home_and_native_stopping[${id}]`,
        ),
      },
      {
        id: "unattended",
        selection: "test_synergy_unattended",
        seconds: 100,
        scenarios: ["test_synergy_unattended_sessions_inherit_and_exclude_question"],
      },
      {
        id: "compaction",
        selection: "test_synergy_compaction",
        seconds: 180,
        scenarios: ["test_synergy_compaction_preserves_file_edits_recording_and_usage"],
      },
      ...[
        "jit-chat-completions-fixture-one",
        "jit-responses-fixture-two",
        "jitless-chat-completions-fixture-two",
        "jitless-responses-fixture-one",
      ].map((id) => ({
        id: `semantics-${id}`,
        selection: `test_synergy_native_semantics and ${id}`,
        seconds: 100,
        scenarios: [`test_synergy_native_semantics[${id}]`],
      })),
    ].map((entry) =>
      task(`native-synergy-${entry.id}`, "benchmark-native", entry.seconds, [], {
        pool: "docker",
        variant: "synergy",
        selection: entry.selection,
        needs: ["benchmark-prepare"],
        files: ["benchmark/test/test_matrix_docker.py"],
        scenarios: entry.scenarios,
        scenarioPrefix: entry.scenarios ? "test_synergy_" : undefined,
      }),
    ),
    ...["completed", "cancelled", "failed"].map((variant) =>
      task(`rollout-${variant}`, "rollout", variant === "completed" ? 320 : 15, ["packages/harness"], {
        variant,
        inputs: ["packages/harness/test/session/rollout-long.test.ts", "packages/harness/test/support/preload.ts"],
      }),
    ),
  ]
  const specialized = new Set(tasks.flatMap((task) => task.files ?? []))
  tasks.find((task) => task.id === "root-tests")!.files = (await collectTests("test/script", root))
    .filter((file) => !specialized.has(file))
    .sort()
  const weights: Record<string, number> = {
    "packages/presets": 500,
    "apps/web": 640,
    "packages/connections": 180,
    "packages/ui": 320,
    "packages/local-runtime": 150,
    "packages/library": 130,
  }
  const times = (await Bun.file(path.join(import.meta.dir, "timings.json")).json()) as Record<string, number>
  const counts: Record<string, number> = {
    "packages/harness": 4,
    "apps/web": 4,
    "packages/presets": 4,
    "packages/ui": 2,
  }
  for (const directory of [...coverage].sort()) {
    const workspace = packages.find((entry) => entry.directory === directory)!
    const dependencies = { ...workspace.dependencies, ...workspace.devDependencies }
    const browser = ["playwright", "playwright-core", "@playwright/test"].some((name) => name in dependencies)
    const files = (await collectTests("test", path.join(root, directory)))
      .filter((file) => !specialized.has(`${directory}/${file}`))
      .sort()
    if (!files.length) throw new Error(`Workspace has no discovered tests: ${directory}`)
    const name = directory.replaceAll("/", "-")
    const count = counts[directory] ?? 1
    const batchShards = Number(/SYNERGY_BATCH_SHARDS=(\d+)/.exec(workspace.scripts?.["test:coverage"] ?? "")?.[1] ?? 4)
    const groups =
      count === 1 ? [files] : partitionSuite(files, path.join(root, directory), count, times, directory, batchShards)
    for (const [index, group] of groups.entries()) {
      const partition = count === 1 ? undefined : index
      tasks.push(
        task(
          `suite-${name}${partition === undefined ? "" : `-${partition}`}`,
          "suite",
          directory === "packages/harness" ? 200 : Math.ceil((weights[directory] ?? 45) / count),
          [directory],
          {
            package: directory,
            partition,
            files: group,
            assets: ["watcher", "plugin"],
            prerequisites: browser ? ["browser"] : [],
          },
        ),
      )
    }
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
    entry.outputs ??=
      entry.kind === "native-workspace" || entry.kind === "windows"
        ? ["junit", "lcov"]
        : entry.kind === "suite"
          ? ["junit", "lcov", "timing"]
          : [
                "policy",
                "artifacts",
                "desktop",
                "sandbox",
                "environment",
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
  for (const entry of tasks) if (times[entry.id] !== undefined) entry.seconds = times[entry.id]!
  return tasks
}
