import { restoreDistribution } from "./distributions"
import { cp, mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "../../packages/testing/src/env"
import { loadManifest } from "../coverage-check"
import { fileHash, filesIn } from "./artifacts"
import { OUTPUT, ROOT } from "./catalog"
import { validatePlan, type Plan, type Task } from "./plan"
import { type Report, type TaskResult } from "./evidence"
import { collectTests } from "../../packages/testing/script/batches"

interface Command {
  name: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}
const bun = (name: string, args: string[], cwd?: string, env?: Record<string, string>): Command => ({
  name,
  args: [process.execPath, ...args],
  cwd,
  env,
})
const run = (name: string): Command => bun(name, ["run", name])
const test = (name: string, files: string[], cwd?: string, env?: Record<string, string>): Command =>
  bun(name, ["test", "--timeout", "30000", ...files], cwd, env)

export async function commands(task: Task, plan: Plan, root = ROOT): Promise<Command[]> {
  const benchmarkEnv = {
    SYNERGY_BENCH_DOCKER: "1",
    SYNERGY_BENCH_TEST_ARTIFACT: path.join(root, OUTPUT, "benchmark/prepared"),
  }
  const pytest = (files: string[], env: Record<string, string> = {}, extra: string[] = []): Command => ({
    name: task.id,
    args: [
      "uv",
      "run",
      "--locked",
      "--project",
      "benchmark",
      "pytest",
      "-s",
      "--durations=30",
      `--junitxml=${path.join(root, OUTPUT, "pytest", `${task.id}.xml`)}`,
      ...(task.diagnosticFiles ?? files),
      ...extra,
    ],
    env,
  })
  switch (task.kind) {
    case "environment": {
      const image = "synergy-execution-host:ci"
      return [
        bun("environment-dependencies", ["install", "--frozen-lockfile"], undefined, {
          ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
        }),
        bun("environment-native-pty", ["packages/local-runtime/script/build-pty.ts"]),
        {
          name: "environment-apparmor",
          args: [
            "sudo",
            "apparmor_parser",
            "-r",
            "packages/local-runtime/src/environment/vendor/synergy-execution.apparmor",
          ],
        },
        bun("environment-image", ["packages/local-runtime/script/build-execution-host.ts", "--image", image]),
        test(
          "environment-lifecycle",
          [
            "test/environment/docker.test.ts",
            "test/environment/profiles.test.ts",
            "test/environment/remote-docker.test.ts",
          ],
          "packages/local-runtime",
          { SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE: image, SYNERGY_TEST_DOCKER_APPARMOR: "1" },
        ),
      ]
    }
    case "policy":
      return [
        ...[
          "format:check",
          "skill:check",
          "package-guide:check",
          "test-layout:check",
          "doc:check",
          "decision:check",
          "secrets:check",
          "workflow:check",
        ].map(run),
        test("oryn-policy", ["--config", "/dev/null", ...task.files!]),
        bun("oryn-snapshot", [".github/oryn/validate.ts", "snapshot"]),
      ]
    case "static":
      return task.variant === "tests"
        ? task.files!.map((file) => test(`root-contract:${file}`, ["--config", "/dev/null", file]))
        : ["lint", "localization:check", "monorepo:check", "brand:gen:check", "deps:check", "deadcode"].map(run)
    case "typecheck": {
      const { workspaces } = await import("../workspace-dependencies")
      const selected = new Set(
        plan.tasks
          .filter((entry) => entry.kind === "suite" && plan.selected.includes(entry.id))
          .map((entry) => entry.package),
      )
      const packages = workspaces(root).filter(
        (entry) => plan.mode === "full" || plan.mode === "shadow" || selected.has(entry.directory),
      )
      return [
        bun("ci-types", ["packages/testing/node_modules/.bin/tsgo", "--project", "script/ci/tsconfig.json"]),
        ...(packages.length
          ? [
              bun("workspace-types", [
                "turbo",
                "typecheck",
                "--concurrency=2",
                ...packages.map((entry) => `--filter=${entry.name}`),
              ]),
            ]
          : []),
      ]
    }
    case "suite": {
      const config = (await loadManifest(root)).packages[task.package!]
      if (!config) throw new Error("Unknown coverage owner")
      const env: Record<string, string> = { SYNERGY_TEST_FILES: JSON.stringify(task.files) }
      // The policy owns the one executable coverage command; CI does not maintain a second package list.
      return [{ name: task.id, args: ["sh", "-c", config.command], cwd: task.package, env }]
    }
    case "packages":
      return [run("package:check")]
    case "web":
      return [
        test("web-build-contract", ["test/app-build-css-contract.test.ts"], "apps/web", {
          SYNERGY_WEB_BUILD_DIR: path.join(root, "apps/web/dist"),
        }),
        bun("private-http", ["apps/web/script/private-http-smoke.ts"]),
        ...(await collectTests("test/plugin-ui5", root)).map((file) =>
          test(`plugin-ui:${path.basename(file)}`, ["--config", "/dev/null", file]),
        ),
      ]
    case "desktop":
      return [
        bun("desktop-build", ["run", "--cwd", "apps/desktop", "desktop:build"]),
        bun("desktop-package", ["x", "electron-builder", "--dir", "--publish=never"], "apps/desktop", {
          SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME: "1",
        }),
        {
          name: "desktop-runtime",
          args: [
            "xvfb-run",
            "-a",
            process.execPath,
            "test",
            "test/browser-runtime-smoke.test.ts",
            "test/startup-progress-runtime.test.ts",
          ],
          cwd: "apps/desktop",
          env: { SYNERGY_DESKTOP_RUNTIME_TEST: "1" },
        },
      ]
    case "smoke":
      return [bun("server-health", ["script/ci/smoke.ts"])]
    case "sandbox":
      return [
        test(
          "linux-sandbox",
          ["test/sandbox/containment-baseline.test.ts", "test/sandbox/linux-readable-roots.test.ts"],
          "packages/local-runtime",
          { SYNERGY_TEST_LINUX_SANDBOX_E2E: "1" },
        ),
      ]
    case "postgres":
      return [
        test(task.id, task.files!, "packages/harness", {
          SYNERGY_REQUIRE_POSTGRES_TESTS: "1",
          SYNERGY_TEST_STORAGE_BACKEND: "postgres",
          SYNERGY_TEST_POSTGRES_URL: "postgres://postgres:storage-ci-only@127.0.0.1:5432/synergy_storage_test",
        }),
      ]
    case "windows":
      if (task.variant === "desktop")
        return [
          test("windows-desktop", ["test/server-manager.test.ts", "test/windows-installer.test.ts"], "apps/desktop"),
        ]
      return [
        {
          name: "windows-helper",
          args: [
            "cargo",
            "test",
            "--locked",
            "--manifest-path",
            "packages/local-runtime/src/sandbox/helper/Cargo.toml",
            "--",
            "--skip",
            "install_wfp_filters_returns_zero_on_non_windows",
            "--skip",
            "install_wfp_filters_for_account_stub_returns_ok_zero",
          ],
        },
        ...["build"].map((command) => ({
          name: `windows-helper-${command}`,
          args: [
            "cargo",
            command,
            "--locked",
            "--manifest-path",
            "packages/local-runtime/src/sandbox/helper/Cargo.toml",
          ],
        })),
        bun("native-pty", ["packages/local-runtime/script/build-pty.ts"]),
        bun("native-workspace", ["script/native-workspace-coverage.ts"]),
        test(
          "windows-harness",
          ["test/global/schema-publish.test.ts", "test/util/server-process-lock.test.ts"],
          "packages/harness",
        ),
        test("windows-util", ["test/fs-lock.test.ts", "test/process-identity.test.ts"], "packages/util"),
        test("windows-home-copy", ["test/cli/data-files.test.ts"], "packages/cli"),
      ]
    case "native-workspace":
      return [
        bun("native-pty", ["packages/local-runtime/script/build-pty.ts"]),
        bun("native-workspace", ["script/native-workspace-coverage.ts"]),
      ]
    case "benchmark-pure":
      return [
        {
          name: "python-lint",
          args: ["uv", "run", "--locked", "--project", "benchmark", "ruff", "check", "benchmark"],
        },
        {
          name: "python-format",
          args: ["uv", "run", "--locked", "--project", "benchmark", "ruff", "format", "--check", "benchmark"],
        },
        {
          name: "python-types",
          args: [
            "uv",
            "run",
            "--locked",
            "--project",
            "benchmark",
            "mypy",
            "--config-file",
            "benchmark/pyproject.toml",
            "benchmark/src/synergy_bench",
          ],
        },
        pytest(task.files!),
        test("benchmark-runtime-recipes", ["--config", "/dev/null", "test"], "benchmark"),
      ]
    case "benchmark-streams":
      return [pytest(task.files!)]
    case "benchmark-prepare":
      return [
        {
          name: "prepare-frozen-runtime",
          args: [
            "uv",
            "run",
            "--locked",
            "--project",
            "benchmark",
            "python",
            "-m",
            "synergy_bench.ci_prepare",
            "--output",
            path.join(root, OUTPUT, "benchmark"),
            "--source",
            root,
          ],
        },
      ]
    case "benchmark-docker":
      return [pytest(task.files!, benchmarkEnv, task.selection ? ["-k", task.selection] : [])]
    case "benchmark-native":
      return [
        pytest(
          task.files!,
          {
            SYNERGY_BENCH_DOCKER: "1",
            SYNERGY_BENCH_TEST_HARNESSES: task.variant!,
            ...(task.variant === "synergy"
              ? {
                  SYNERGY_BENCH_NATIVE_ARTIFACTS: JSON.stringify({ synergy: benchmarkEnv.SYNERGY_BENCH_TEST_ARTIFACT }),
                }
              : {}),
          },
          task.selection ? ["-k", task.selection] : [],
        ),
      ]
    case "rollout":
      return [
        test(
          task.id,
          ["test/session/rollout-long.test.ts", "--test-name-pattern", `: ${task.variant}$`],
          "packages/harness",
          { SYNERGY_ROLLOUT_LONG_STREAM: "1", SYNERGY_CI_TIMING: "1" },
        ),
      ]
    case "artifacts": {
      const owner = task.profile === "core" ? "cli" : "presets"
      const scenarioPrefix = "installed runtime artifact preserves "
      const scenarios = task.scenarios?.map((name) =>
        name.slice(scenarioPrefix.length).replace(" outcome outside the repository", ""),
      )
      if (task.variant === "binary")
        return [
          ...(task.files?.length ? [test("watcher-native", ["--config", "/dev/null", ...task.files])] : []),
          test("installed-behavior", ["test/cli/artifact.test.ts"], "packages/cli", {
            SYNERGY_TEST_ARTIFACT_PROFILE: task.profile!,
            SYNERGY_TEST_ARTIFACT_BIN: path.join(root, `packages/${owner}/dist/synergy-linux-x64/bin/synergy`),
            SYNERGY_TEST_ARTIFACT_SCENARIOS: JSON.stringify(scenarios),
          }),
        ]
      if (task.variant === "package")
        return [
          bun(
            "core-install",
            ["script/package-install-check.ts", path.join(root, OUTPUT, "core-packages")],
            undefined,
            {
              SYNERGY_TEST_ARTIFACT_PROFILE: "core",
              SYNERGY_TEST_ARTIFACT_SCENARIOS: JSON.stringify(scenarios),
              SYNERGY_TEST_ARTIFACT_JUNIT: path.join(root, OUTPUT, "raw", task.id, "installed.xml"),
            },
          ),
        ]
      if (task.variant === "composition")
        return [
          bun("product-composition", [
            "script/runtime-composition-check.ts",
            path.join(root, "packages/presets/dist/modules-packages"),
          ]),
        ]
      if (task.variant === "components" || task.variant === "company" || task.variant === "web")
        return [
          bun("installation-composition", [
            "script/installation-composition-check.ts",
            path.join(root, "packages/presets/dist/modules-packages"),
            task.variant,
          ]),
        ]
      throw new Error(`Unknown installed runtime control: ${task.id}`)
    }
  }
}

function nativeCoverageDirectory(task: Task, root: string): string | undefined {
  if (task.kind !== "native-workspace" && !(task.kind === "windows" && task.variant !== "desktop")) return undefined
  return path.join(root, task.package!, "coverage/shards", task.pool === "windows" ? "1000001" : "1000000")
}

async function captureReports(task: Task, root: string, output: string): Promise<Report[]> {
  const reports: Report[] = []
  const sources =
    task.kind === "suite"
      ? await filesIn(path.join(root, task.package!, "coverage"))
      : await filesIn(path.join(root, OUTPUT, "raw", task.id))
  const native = nativeCoverageDirectory(task, root)
  if (native) sources.push(...(await filesIn(native)))
  const pytestFile = path.join(root, OUTPUT, "pytest", `${task.id}.xml`)
  if (await Bun.file(pytestFile).exists()) sources.push(pytestFile)
  for (const file of sources) {
    const kind = file.endsWith("lcov.info")
      ? "lcov"
      : file.endsWith(".xml")
        ? "junit"
        : file.endsWith("timing.json") || file.endsWith("timing.jsonl")
          ? "timing"
          : undefined
    if (!kind) continue
    const relative =
      native && file.startsWith(native + path.sep)
        ? path.join("native", path.relative(native, file))
        : path.relative(
            task.kind === "suite"
              ? path.join(root, task.package!, "coverage")
              : file === pytestFile
                ? path.join(root, OUTPUT, "pytest")
                : path.join(root, OUTPUT, "raw", task.id),
            file,
          )
    const destination = path.join(output, task.id, "reports", relative)
    await mkdir(path.dirname(destination), { recursive: true })
    if (kind === "lcov") {
      const owner = path.join(root, task.package!)
      const normalized = (await readFile(file, "utf8")).replace(
        /^SF:(.+)$/gm,
        (_, name: string) => `SF:${path.relative(owner, path.resolve(owner, name)).split(path.sep).join("/")}`,
      )
      await Bun.write(destination, normalized)
    } else await cp(file, destination)
    reports.push({
      path: path.relative(output, destination).split(path.sep).join("/"),
      sha256: await fileHash(destination),
      kind,
      ...(task.package ? { package: task.package } : {}),
    })
  }
  return reports
}

export async function executeTask(task: Task, plan: Plan, root = ROOT): Promise<TaskResult> {
  const output = path.join(root, OUTPUT, "results")
  await rm(path.join(output, task.id), { recursive: true, force: true })
  const raw = path.join(root, OUTPUT, "raw", task.id)
  await rm(raw, { recursive: true, force: true })
  await rm(path.join(root, OUTPUT, "pytest", `${task.id}.xml`), { force: true })
  await mkdir(raw, { recursive: true })
  if (task.kind === "suite") await rm(path.join(root, task.package!, "coverage"), { recursive: true, force: true })
  const native = nativeCoverageDirectory(task, root)
  if (native) await rm(native, { recursive: true, force: true })
  const result: TaskResult = {
    version: 2,
    task: task.id,
    unit: plan.units.find((unit) => unit.tasks.includes(task.id))?.id ?? task.id,
    plan: plan.digest,
    sha: plan.sha,
    run: plan.run,
    planAttempt: plan.attempt,
    executionAttempt: process.env.GITHUB_RUN_ATTEMPT ?? plan.attempt,
    mode: plan.mode,
    status: "failure",
    exitCode: 1,
    started: new Date().toISOString(),
    completed: "",
    reports: [],
    steps: [],
  }
  const isolated = await createIsolatedTestEnv()
  try {
    const list = await commands(task, plan, root)
    for (const command of list) {
      console.info(`::group::${task.id}: ${command.name}`)
      const started = performance.now()
      const args = [...command.args]
      const executable = args.indexOf(process.execPath)
      if (executable >= 0 && args[executable + 1] === "test")
        args.splice(
          executable + 2,
          0,
          "--reporter=junit",
          `--reporter-outfile=${path.join(raw, `${result.steps.length}.xml`)}`,
        )
      const child = Bun.spawn(args, {
        cwd: path.resolve(root, command.cwd ?? "."),
        env: {
          ...isolated.env,
          SYNERGY_BENCH_TIMINGS: path.join(root, OUTPUT, "raw", task.id, "benchmark-timing.jsonl"),
          SYNERGY_CI_TIMING_OUTPUT: path.join(root, OUTPUT, "raw", task.id, "rollout-timing.jsonl"),
          ...command.env,
          ...(command.name.endsWith("-build") && task.kind === "artifacts"
            ? { SYNERGY_HOME: path.join(isolated.env.SYNERGY_TEST_ROOT!, "build-home") }
            : {}),
          HUSKY: "0",
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      const exitCode = await child.exited
      result.steps.push({ name: command.name, seconds: (performance.now() - started) / 1000, exitCode })
      console.info("::endgroup::")
      if (exitCode !== 0) {
        result.exitCode = exitCode
        break
      }
    }
    if (result.steps.length === list.length && result.steps.every((step) => step.exitCode === 0)) {
      result.status = "success"
      result.exitCode = 0
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  } finally {
    try {
      await isolated.dispose()
    } catch (error) {
      result.status = "failure"
      result.exitCode = 1
      console.error(error)
    }
    result.completed = new Date().toISOString()
    result.reports = await captureReports(task, root, output)
    await Bun.write(path.join(output, task.id, "result.json"), JSON.stringify(result, null, 2))
  }
  return result
}

export async function executeUnit(
  plan: Plan,
  id: string,
  root = ROOT,
  prepareInput?: (profile: "core" | "full" | "benchmark") => Promise<void>,
) {
  validatePlan(plan)
  const unit = plan.units.find((entry) => entry.id === id)
  const ids = unit?.tasks ?? (id === "benchmark-prepare" && plan.selected.includes(id) ? [id] : undefined)
  if (!ids) throw new Error(`Unknown execution unit: ${id}`)
  const prepared = new Map<string, Promise<void>>()
  const failures: string[] = []
  const ordered = ids.toSorted(
    (a, b) =>
      Number(
        !!plan.tasks.find((task) => task.id === a)!.profile ||
          plan.tasks.find((task) => task.id === a)!.needs.includes("benchmark-prepare"),
      ) -
      Number(
        !!plan.tasks.find((task) => task.id === b)!.profile ||
          plan.tasks.find((task) => task.id === b)!.needs.includes("benchmark-prepare"),
      ),
  )
  async function execute(taskID: string) {
    const task = plan.tasks.find((entry) => entry.id === taskID)!
    const profile = task.profile ?? (task.needs.includes("benchmark-prepare") ? "benchmark" : undefined)
    if (profile) {
      if (!prepared.has(profile))
        prepared.set(
          profile,
          (async () => {
            await prepareInput?.(profile)
            if (profile !== "benchmark") await restoreDistribution(root, plan, profile)
          })(),
        )
      await prepared.get(profile)
    }
    const result = await executeTask(task, plan, root)
    if (result.status !== "success") failures.push(taskID)
  }
  let cursor = 0
  const workers = await Promise.allSettled(
    Array.from(
      {
        length:
          unit?.pool === "docker"
            ? 2
            : unit?.pool === "linux" && unit.id !== "linux-contracts" && plan.mode !== "diagnostic"
              ? 2
              : 1,
      },
      async () => {
        while (cursor < ordered.length) await execute(ordered[cursor++]!)
      },
    ),
  )
  const rejected = workers.find((worker) => worker.status === "rejected")
  if (rejected?.status === "rejected") throw rejected.reason
  return failures.sort()
}
