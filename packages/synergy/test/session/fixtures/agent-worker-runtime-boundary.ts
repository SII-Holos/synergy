import path from "path"
import ts from "typescript"

const packageRoot = process.cwd()
const workspaceRoot = path.resolve(packageRoot, "../..")
const entrypoint = path.join(packageRoot, "src/session/agent-turn/runner.ts")
const visited = new Set<string>()
const parent = new Map<string, string>()
const forbiddenExternalImports = new Set<string>()

function valueImports(source: ts.SourceFile): string[] {
  const imports: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      imports.push(statement.moduleSpecifier.text)
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      imports.push(statement.moduleSpecifier.text)
    }
  }
  return imports
}

async function visit(file: string): Promise<void> {
  const normalized = path.normalize(file)
  if (visited.has(normalized)) return
  visited.add(normalized)
  const source = ts.createSourceFile(
    normalized,
    await Bun.file(normalized).text(),
    ts.ScriptTarget.Latest,
    false,
    normalized.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  for (const specifier of valueImports(source)) {
    if (specifier.startsWith("@ai-sdk/") || specifier === "@openrouter/ai-sdk-provider") {
      forbiddenExternalImports.add(specifier)
    }
    let resolved: string
    try {
      resolved = Bun.resolveSync(specifier, path.dirname(normalized))
    } catch {
      continue
    }
    if (!resolved.startsWith(workspaceRoot + path.sep) || resolved.includes(`${path.sep}node_modules${path.sep}`)) {
      continue
    }
    if (!parent.has(resolved)) parent.set(resolved, normalized)
    await visit(resolved)
  }
}

await visit(entrypoint)
const inputs = [...visited].map((file) => path.relative(workspaceRoot, file))
const forbidden = inputs.filter(
  (input) =>
    input.startsWith("packages/synergy/src/browser/") ||
    input.startsWith("packages/synergy/src/plugin/") ||
    input.startsWith("packages/synergy/src/plugin-runtime/") ||
    input.startsWith("packages/synergy/src/tool/") ||
    input.startsWith("packages/browser/"),
)
forbidden.push(...[...forbiddenExternalImports].map((specifier) => `external:${specifier}`))

const dependencyPath = (relative: string) => {
  const result: string[] = []
  let current: string | undefined = path.join(workspaceRoot, relative)
  while (current) {
    result.unshift(path.relative(workspaceRoot, current))
    current = parent.get(current)
  }
  return result
}

console.log(
  JSON.stringify({
    success: true,
    logs: [],
    entryFound: visited.has(entrypoint),
    forbidden,
    firstForbiddenPath: forbidden[0] ? dependencyPath(forbidden[0]) : [],
  }),
)
