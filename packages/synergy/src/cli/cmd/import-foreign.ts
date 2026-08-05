import type { Argv } from "yargs"
import { EOL } from "os"
import { cmd } from "./cmd"
import { withScopeContext } from "../scope"
import { ForeignImport } from "../../session/import/foreign-import"

type Source = ForeignImport.Source

interface ForeignImportArgs {
  file?: string
  dir?: string
  dryRun?: boolean
  limit?: number
  includeSidechains?: boolean
  includeThinking?: boolean
}

function sourceLabel(source: ForeignImport.Source): string {
  return source === "claude-code" ? "Claude Code" : "Codex"
}

function describeSource(source: ForeignImport.Source): string {
  return source === "claude-code"
    ? "import a Claude Code transcript (jsonl from ~/.claude/projects) as a Synergy session"
    : "import a Codex CLI transcript (jsonl from ~/.codex/sessions) as a Synergy session"
}

function builder(yargs: Argv, source: ForeignImport.Source) {
  return yargs
    .positional("file", {
      describe: `path to a ${sourceLabel(source)} transcript jsonl file`,
      type: "string",
    })
    .option("dir", {
      describe: `scan a custom directory instead of the default (${ForeignImport.defaultRoot(source)})`,
      type: "string",
    })
    .option("dry-run", {
      describe: "list matching transcript files without importing",
      type: "boolean",
      default: false,
    })
    .option("limit", {
      describe: "import at most N sessions (newest first)",
      type: "number",
    })
    .option("include-sidechains", {
      describe: "also import subagent (sidechain) transcripts",
      type: "boolean",
      default: false,
    })
    .option("include-thinking", {
      describe: "include thinking/reasoning blocks as reasoning parts",
      type: "boolean",
      default: false,
    })
}

async function handler(source: ForeignImport.Source, args: ForeignImportArgs) {
  await withScopeContext(process.cwd(), async () => {
    try {
      if (args.file) {
        const file = Bun.file(args.file)
        if (!(await file.exists())) {
          process.stdout.write(`File not found: ${args.file}${EOL}`)
          return
        }
        const result = await ForeignImport.importFile(args.file, {
          source,
          includeSidechains: args.includeSidechains,
          includeThinking: args.includeThinking,
        })
        const r = result.result
        process.stdout.write(
          `Imported ${sourceLabel(source)} session: ${r.rootSessionID} (${r.sessionCount} session${
            r.sessionCount === 1 ? "" : "s"
          }, ${r.messageCount} message${r.messageCount === 1 ? "" : "s"})${EOL}`,
        )
        for (const warning of r.warnings) {
          process.stdout.write(`Warning: ${warning}${EOL}`)
        }
        if (result.stats.skippedLines > 0 || result.stats.unknownTypes > 0) {
          process.stdout.write(
            `Note: ${result.stats.skippedLines} malformed line(s), ${result.stats.unknownTypes} unknown type(s) skipped${EOL}`,
          )
        }
        return
      }

      const candidates = await ForeignImport.scanCandidates(source, args.dir)
      if (candidates.length === 0) {
        process.stdout.write(
          `No ${sourceLabel(source)} transcripts found${args.dir ? ` in ${args.dir}` : ` under ${ForeignImport.defaultRoot(source)}`}.${EOL}`,
        )
        return
      }

      const limited = args.limit ? candidates.slice(0, args.limit) : candidates
      if (args.dryRun) {
        process.stdout.write(
          `${limited.length} ${sourceLabel(source)} transcript(s) found (${candidates.length} total):${EOL}`,
        )
        for (const candidate of limited) {
          const size = (candidate.sizeBytes / 1024).toFixed(1)
          process.stdout.write(`- ${candidate.path} (${size} KB, ${new Date(candidate.created).toISOString()})${EOL}`)
        }
        return
      }

      process.stdout.write(`Importing ${limited.length} ${sourceLabel(source)} session(s)...${EOL}`)
      const job = ForeignImport.start({
        source,
        paths: limited.map((c) => c.path),
        includeSidechains: args.includeSidechains,
        includeThinking: args.includeThinking,
      })
      // Poll the in-memory job to completion (CLI runs are short-lived).
      while (true) {
        const current = ForeignImport.currentSummary()
        if (!current || current.status !== "running") break
        await Bun.sleep(200)
      }
      const summary = ForeignImport.currentSummary()
      if (summary) {
        process.stdout.write(
          `Done: ${summary.okCount} imported, ${summary.failedCount} failed, ${summary.completedCount}/${summary.totalCount} completed${EOL}`,
        )
        const jobState = ForeignImport.getJob(summary.id)
        for (const item of jobState?.items ?? []) {
          if (item.status === "failed") {
            process.stdout.write(`Failed: ${item.path} — ${item.error ?? "unknown error"}${EOL}`)
          }
        }
        if (summary.status === "cancelled") {
          process.stdout.write(`Job cancelled after ${summary.completedCount} of ${summary.totalCount}.${EOL}`)
        }
      }
    } catch (error) {
      process.stderr.write(`Import failed: ${error instanceof Error ? error.message : String(error)}${EOL}`)
      process.exitCode = 1
    }
  })
}

export const ImportClaudeCommand = cmd({
  command: "import-claude [file]",
  describe: describeSource("claude-code"),
  builder: (yargs: Argv) => builder(yargs, "claude-code"),
  handler: async (args) => handler("claude-code", args as ForeignImportArgs),
})

export const ImportCodexCommand = cmd({
  command: "import-codex [file]",
  describe: describeSource("codex"),
  builder: (yargs: Argv) => builder(yargs, "codex"),
  handler: async (args) => handler("codex", args as ForeignImportArgs),
})
