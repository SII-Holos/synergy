#!/usr/bin/env bun
import path from "node:path"
import { mkdir, readdir, readFile, rm, copyFile } from "node:fs/promises"
import ts from "typescript"
import { prepareBuildModelsCatalog } from "./release/shared/build/models-catalog"

const repository = path.resolve(import.meta.dir, "..")

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        if (["node_modules", "target", ".git"].includes(entry.name)) return []
        const file = path.join(directory, entry.name)
        return entry.isDirectory() ? filesIn(file) : [file]
      }),
    )
  ).flat()
}

export async function buildWorkspace(directory: string, options: { output?: string } = {}) {
  const root = path.resolve(repository, directory)
  const source = path.join(root, "src")
  const output = path.join(root, options.output ?? "dist")
  const files = await filesIn(source)
  const known = new Set(files)
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  for (const [entry, value] of Object.entries(manifest.exports ?? {})) {
    if (entry.includes("*")) throw new Error(`${manifest.name}: public entries must be explicit`)
    const target = typeof value === "string" ? value : (value as { types?: string }).types
    if (target && target.startsWith("./src/") && !known.has(path.resolve(root, target))) {
      throw new Error(`${manifest.name}: missing export ${entry}: ${target}`)
    }
  }
  await rm(output, { recursive: true, force: true })
  if (manifest.name === "@ericsanchezok/synergy-harness") {
    const catalog = await prepareBuildModelsCatalog({})
    await Bun.write(
      path.join(output, "provider/models-snapshot.json"),
      JSON.stringify(await Bun.file(catalog.path).text()),
    )
  }
  for (const file of files) {
    const relative = path.relative(source, file)
    const isCode = /\.(ts|tsx|mts)$/.test(file) && !file.endsWith(".d.ts")
    const destination = path.join(output, isCode ? relative.replace(/\.(ts|tsx|mts)$/, ".js") : relative)
    await mkdir(path.dirname(destination), { recursive: true })
    if (!isCode) {
      await copyFile(file, destination)
      continue
    }
    const original = await readFile(file, "utf8")
    const syntax = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true)
    const replacements: Array<{ start: number; end: number; value: string }> = []
    function visit(node: ts.Node) {
      if (
        manifest.name === "@ericsanchezok/synergy-harness" &&
        relative.split(path.sep).join("/") === "provider/models.ts"
      ) {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "./models-macro"
        ) {
          replacements.push({
            start: node.getStart(syntax),
            end: node.getEnd(),
            value: 'import data from "./models-snapshot.json" with { type: "json" };',
          })
          return
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "bundledText" &&
          node.initializer
        ) {
          replacements.push({ start: node.initializer.getStart(syntax), end: node.initializer.getEnd(), value: "data" })
          return
        }
      }
      if (ts.isStringLiteralLike(node) && node.text.startsWith(".")) {
        const parent = node.parent
        const module =
          ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          (ts.isCallExpression(parent) &&
            (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
              parent.expression.getText(syntax) === "require" ||
              parent.expression.getText(syntax) === "import.meta.resolve"))
        const resource =
          ts.isNewExpression(parent) && parent.expression.getText(syntax) === "URL" && parent.arguments?.[0] === node
        if (module || resource) {
          const base = path.resolve(path.dirname(file), node.text)
          const target = [
            base,
            base.replace(/\.js$/, ".ts"),
            `${base}.ts`,
            `${base}.tsx`,
            path.join(base, "index.ts"),
          ].find((candidate) => known.has(candidate))
          if (target && /\.(ts|tsx|mts)$/.test(target)) {
            let value = path.relative(path.dirname(file), target).replace(/\.(ts|tsx|mts)$/, ".js")
            if (!value.startsWith(".")) value = `./${value}`
            replacements.push({ start: node.getStart(syntax) + 1, end: node.getEnd() - 1, value })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(syntax)
    let input = original
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      input = input.slice(0, replacement.start) + replacement.value + input.slice(replacement.end)
    }
    const compiled = ts.transpileModule(input, {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
      reportDiagnostics: true,
    })
    const errors =
      compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
    if (errors.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => root,
          getNewLine: () => "\n",
        }),
      )
    await Bun.write(destination, compiled.outputText)
  }
  return { name: manifest.name as string, files: files.length, output }
}

if (import.meta.main) {
  const directory = process.argv[2]
  if (!directory) throw new Error("Usage: bun script/build-workspace.ts <workspace directory> [output directory]")
  console.log(await buildWorkspace(directory, { output: process.argv[3] }))
}
