import { expect, test } from "bun:test"
import ts from "typescript"

test("CLI worker dispatch entry has no eager runtime imports", async () => {
  const entry = new URL("../../src/index.ts", import.meta.url)
  const source = ts.createSourceFile(entry.pathname, await Bun.file(entry).text(), ts.ScriptTarget.Latest, false)
  const eager = source.statements.flatMap((statement) => {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text]
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text]
    }
    return []
  })
  expect(eager).toEqual([])
})
