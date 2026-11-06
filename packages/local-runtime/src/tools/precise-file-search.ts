import { FileView } from "../file/view"
import { Ripgrep } from "../file/ripgrep"
import { OutputBudget, DEFAULT_VIEW_BYTES } from "./anchored-file"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"

export async function preciseFileSearch(
  params: {
    mode: "paths" | "content"
    query: string
    syntax?: "literal" | "regex"
    path?: string
    offset?: number
    limit?: number
    include?: string
    exclude?: string
  },
  ctx: Tool.Context,
) {
  const cwd = FileView.resolve(params.path ?? ".")
  const split = (value?: string) =>
    value
      ?.split(",")
      .map((pattern) => pattern.trim())
      .filter(Boolean) ?? []
  const include = split(params.include)
  const exclude = split(params.exclude).map((pattern) => `!${pattern}`)
  const hits: {
    kind: "path" | "content"
    path: string
    line?: number
    column?: number
    text?: string
    truncated?: boolean
  }[] = []
  if (params.mode === "paths") {
    const included = include.length ? new Set<string>() : undefined
    if (included)
      for await (const file of Ripgrep.files({ cwd, glob: [...include, ...exclude], follow: false, signal: ctx.abort }))
        included.add(file)
    for await (const file of Ripgrep.files({
      cwd,
      glob: [params.query, ...exclude],
      follow: false,
      signal: ctx.abort,
    })) {
      if (!included || included.has(file))
        hits.push({ kind: "path", path: FileView.relative(FileView.resolve(file, cwd)) })
    }
  } else {
    for await (const match of Ripgrep.matches({
      cwd,
      pattern: params.query,
      fixedStrings: params.syntax !== "regex",
      glob: [...include, ...exclude],
      hidden: true,
      follow: false,
      sortPath: true,
      signal: ctx.abort,
    })) {
      const text = match.lines.text.replace(/\r?\n$/, "")
      for (const position of match.submatches)
        hits.push({
          kind: "content",
          path: FileView.relative(FileView.resolve(match.path.text, cwd)),
          line: match.line_number,
          column: [...Buffer.from(text).subarray(0, position.start).toString("utf8")].length + 1,
          text: text.slice(0, 2000),
          truncated: text.length > 2000,
        })
    }
  }
  ctx.abort.throwIfAborted()
  hits.sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  )
  const offset = params.offset ?? 0
  const limit = params.limit ?? 50
  const continuation = (next: number) =>
    `Continue with offset=${next}; narrow the query if a result exceeds the output budget.`
  const reserved = `[Results omitted by the result limit.]\n[Results omitted by the shared byte budget.]\n${continuation(hits.length)}`
  const budget = new OutputBudget(DEFAULT_VIEW_BYTES - Buffer.byteLength(reserved) - 2)
  const displayed: typeof hits = []
  const rows: string[] = []
  let byteLimited = false
  for (const hit of hits.slice(offset, offset + limit)) {
    const row =
      hit.kind === "path"
        ? hit.path
        : `${hit.path}:${hit.line}:${hit.column}: ${hit.text}${hit.truncated ? "… [line shortened]" : ""}`
    if (!budget.take(row)) {
      byteLimited = true
      break
    }
    rows.push(row)
    displayed.push(hit)
  }
  const resultLimited = hits.length > offset + limit
  const nextOffset = offset + displayed.length < hits.length ? offset + displayed.length : undefined
  const guidance = [
    resultLimited ? "[Results omitted by the result limit.]" : "",
    byteLimited ? "[Results omitted by the shared byte budget.]" : "",
    nextOffset !== undefined ? continuation(nextOffset) : "",
  ].filter(Boolean)
  const output = [...(rows.length ? rows : ["No results displayed."]), ...guidance].join("\n")
  await ctx.ask({
    permission: "file_search",
    patterns: [...new Set(displayed.length ? displayed.map((hit) => FileView.resolve(hit.path)) : [cwd])],
    metadata: { query: params.query, mode: params.mode },
  })
  return {
    title: params.query,
    output,
    activityEvidence: await ctx.recordActivity?.({
      kind: "search",
      directory: FileView.directory(),
      mediaType: "application/vnd.synergy.search+json",
      text: JSON.stringify({ hits: displayed }),
      truncated: nextOffset !== undefined,
    }),
    metadata: {
      mode: params.mode,
      query: params.query,
      syntax: params.mode === "content" ? (params.syntax ?? "literal") : undefined,
      pathCount: params.mode === "paths" ? hits.length : 0,
      contentCount: params.mode === "content" ? hits.length : 0,
      symbolCount: 0,
      displayedCounts: {
        path: params.mode === "paths" ? displayed.length : 0,
        content: params.mode === "content" ? displayed.length : 0,
        symbol: 0,
      },
      contentError: undefined as string | undefined,
      count: displayed.length,
      total: hits.length,
      truncated: nextOffset !== undefined,
      resultLimited,
      byteLimited,
      nextOffset,
      nextCursor: undefined as string | undefined,
    },
  }
}
