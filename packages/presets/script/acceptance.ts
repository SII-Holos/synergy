import path from "node:path"
import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { selectCases } from "./acceptance/catalog"
import { Plan, execute, loadPlan, makePlan, report } from "./acceptance/runner"
import { atomicJSON } from "./acceptance/evidence"

const root = path.resolve(import.meta.dir, "../../..")
function source() {
  if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
    throw new Error("Commit the acceptance implementation before freezing or executing source")
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
}

export async function main(args: string[]) {
  const [command, ...rest] = args
  const { values } = parseArgs({
    args: rest,
    options: {
      case: { type: "string" },
      out: { type: "string" },
      settings: { type: "string" },
      input: { type: "string", multiple: true },
      retry: { type: "string" },
      reason: { type: "string" },
      help: { type: "boolean" },
    },
  })
  if (values.help || !command || command === "--help") {
    process.stdout.write(
      "Local joint architecture acceptance\n\n" +
        "plan --case <id,id|all> --out <private-directory> --settings <settings.json> [--input <name=path>]\n" +
        "run --out <private-directory>\n" +
        "resume --out <private-directory> [--retry <id,id> --reason <explanation>]\n" +
        "report --out <private-directory>\n\n" +
        "Live scenarios call the configured provider. Failed or interrupted attempts are never silently retried.\n" +
        selectCases("all")
          .map((entry) => `${entry.id}${entry.live ? " (live model)" : ""}`)
          .join("\n") +
        "\n",
    )
    return
  }
  if (!["plan", "run", "resume", "report"].includes(command)) throw new Error("Unknown acceptance command")
  if (!values.out) throw new Error("An explicit private output directory is required")
  const directory = path.resolve(values.out)
  if (directory === root || directory.startsWith(root + path.sep))
    throw new Error("Acceptance data must stay outside the source checkout")
  if (command === "plan") {
    if (!values.case || !values.settings) throw new Error("Planning requires explicit cases and frozen settings")
    const { Settings } = await import("./acceptance/runtime")
    const settingsFile = path.resolve(values.settings)
    const settings = Settings.parse(await Bun.file(settingsFile).json())
    const inputs = [
      { name: "settings", path: settingsFile },
      { name: "models", path: settings.modelCatalog },
      { name: "provider-credential", path: settings.apiKeyFile },
      { name: "dependencies", path: path.join(root, "bun.lock") },
      ...(settings.chromium ? [{ name: "chromium", path: settings.chromium }] : []),
      ...Object.entries(settings.remote ?? {}).flatMap(([kind, value]) =>
        typeof value === "object"
          ? Object.entries(value).map(([name, file]) => ({ name: `${kind}-${name}`, path: file }))
          : [],
      ),
      ...(values.input ?? []).map((value) => {
        const separator = value.indexOf("=")
        if (separator <= 0) throw new Error("Input uses name=path syntax")
        return { name: value.slice(0, separator), path: path.resolve(value.slice(separator + 1)) }
      }),
    ]
    const plan = await makePlan({ source: source(), directory, cases: selectCases(values.case), inputs })
    process.stdout.write(
      JSON.stringify({ source: plan.source, plan: plan.digest, cases: plan.cases.map((entry) => entry.id) }, null, 2) +
        "\n",
    )
    return
  }
  if (command === "run" || command === "resume") {
    const plan = await loadPlan(directory)
    const input = plan.inputs.find((entry) => entry.name === "settings")
    if (!input) throw new Error("Frozen settings are missing")
    const { Settings } = await import("./acceptance/runtime")
    const settings = Settings.parse(await Bun.file(input.path).json())
    const { attachments } = await import("./acceptance/attachments")
    const driver = attachments(settings)
    const { remoteFault } = await import("./acceptance/remote")
    const { media } = await import("./acceptance/media")
    await execute(
      plan,
      {
        ...Object.fromEntries(["home", "project", "workspace"].map((kind) => [`attachments-${kind}`, driver])),
        ...Object.fromEntries(["attachment-policy", "vision-child"].map((id) => [id, media(settings)])),
        ...(settings.remote
          ? Object.fromEntries(["fault-command-crash", "fault-save-crash"].map((id) => [id, remoteFault(settings)]))
          : {}),
      },
      {
        source: source(),
        resume: command === "resume",
        retry: values.retry?.split(","),
        reason: values.reason,
      },
    )
  }
  const plan = Plan.parse(await Bun.file(path.join(directory, "plan.json")).json())
  const result = await report(plan)
  await atomicJSON(path.join(directory, "report.json"), result)
  const markdown = [
    "# Joint architecture acceptance",
    "",
    `Source: ${result.source}`,
    `Plan: ${result.plan}`,
    "",
    `Accepted: ${result.passed ? "yes" : "no"}`,
    "",
    "| Scenario | Result | Attempts |",
    "| --- | --- | --- |",
    ...result.cases.map((entry) => `| ${entry.id} | ${entry.status} | ${entry.attempts} |`),
    "",
    `Recorded requests: ${result.usage.requests}; unknown usage: ${result.usage.unknownUsage}; attempts without accounting: ${result.usage.unaccountedAttempts}.`,
    `Known token totals: input ${result.usage.input}, output ${result.usage.output}. These totals exclude unknown usage.`,
    "",
    ...result.limits.map((limit) => `- ${limit}`),
    "",
  ].join("\n")
  await Bun.write(path.join(directory, "report.md"), markdown, { mode: 0o600 })
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  if (!result.passed) process.exitCode = 1
}

if (import.meta.main) await main(process.argv.slice(2))
