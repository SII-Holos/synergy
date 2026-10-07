import ts from "typescript"

export type SourceFacts = {
  specifiers: string[]
  literals: string[]
  hasExports: boolean
  dynamicReferences: boolean
  dynamicReads: boolean
}

export function analyzeSource(file: string, source: string): SourceFacts {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const specifiers = new Set<string>()
  const literals: string[] = []
  let hasExports = false
  let dynamicReferences = false
  let dynamicReads = false
  function visit(node: ts.Node) {
    if (
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    )
      hasExports = true
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text)
      const parent = node.parent
      if (
        (ts.isModuleDeclaration(parent) && parent.name === node) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isNewExpression(parent) &&
          parent.expression.getText(syntax) === "URL" &&
          parent.arguments?.[0] === node &&
          parent.arguments?.[1]?.getText(syntax) === "import.meta.url") ||
        (ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            ["require", "import.meta.resolve"].includes(parent.expression.getText(syntax))))
      )
        specifiers.add(node.text)
    }
    if (ts.isCallExpression(node) && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))) {
      const expression = node.expression.getText(syntax)
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ["require", "import.meta.resolve"].includes(expression)
      )
        dynamicReferences = true
      if (["Bun.file", "readFile", "readFileSync"].includes(expression)) dynamicReads = true
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(syntax) === "URL" &&
      node.arguments?.[1]?.getText(syntax) === "import.meta.url" &&
      (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
    )
      dynamicReferences = true
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  return { specifiers: [...specifiers], literals, hasExports, dynamicReferences, dynamicReads }
}
