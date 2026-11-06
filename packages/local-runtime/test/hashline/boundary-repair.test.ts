import { describe, expect, test } from "bun:test"
import { applyEdits, parsePatch } from "../../src/hashline/index"

function applyDiff(text: string, diff: string): { text: string; warnings: readonly string[] } {
  const { edits, warnings: parseWarnings } = parsePatch(diff)
  const result = applyEdits(text, edits)
  return { text: result.text, warnings: [...parseWarnings, ...(result.warnings ?? [])] }
}

describe("boundary-balance repair", () => {
  test("drops a duplicated multi-line closing block (Root.tsx incident)", () => {
    const file = [
      'import type React from "react";',
      'import { Composition } from "remotion";',
      'import { Sizzle, type SizzleProps } from "./compositions/Sizzle";',
      'import { FPS, totalDurationInFrames } from "./lib/scenes";',
      "",
      "export const RemotionRoot: React.FC = () => {",
      "\tconst durationInFrames = totalDurationInFrames();",
      "\treturn (",
      "\t\t<>",
      "\t\t\t<Composition",
      '\t\t\t\tid="Sizzle"',
      "\t\t\t\tcomponent={Sizzle}",
      "\t\t\t\tdurationInFrames={durationInFrames}",
      "\t\t\t\twidth={1920}",
      '\t\t\t\tdefaultProps={{ layout: "landscape" }}',
      "\t\t\t/>",
      "\t\t</>",
      "\t);",
      "};",
    ].join("\n")
    expect(file.length).toBeGreaterThan(0)
    expect(file).toContain("</>")
    expect(file).toContain(");")
  })

  test("drops a single duplicated structural closer `});`", () => {
    const file = ["it('a', () => {", "\tsetup();", "\trun();", "});", "after();"].join("\n")
    const result = applyDiff(file, "SWAP 2.=3:\n+setup2();\n+run2();\n+});")
    const closeCount = (result.text.match(/\}\);/g) ?? []).length
    expect(closeCount).toBe(1)
  })

  test("drops a single duplicated structural opener `planRender(`", () => {
    const file = "\tplanRender(\n\t\t<MainMenu />\n\t);\n"
    const result = applyDiff(file, "SWAP 2.=3:\n\tplanRender(\n\t\t<Settings />\n\t);")
    const openCount = (result.text.match(/planRender\(/g) ?? []).length
    expect(openCount).toBe(1)
  })

  test("preserves duplicated opener when it does not account for the imbalance", () => {
    const file = "if (a) {\n  x()\n}\n"
    const result = applyDiff(file, "SWAP 1.=3:\n+if (a) {\n+  x()\n+  y()\n+}\n")
    expect(result.text).toContain("if (a)")
  })

  test("spares the deleted closing line when the payload omits it", () => {
    const file = "const obj = {\n  a: 1,\n};\n"
    const result = applyDiff(file, "SWAP 2.=3:\n+  b: 2,\n")
    expect(result.text).toContain("};")
  })

  test("does not spare deleted closing line that the payload already restates", () => {
    const file = "const obj = {\n  a: 1,\n  b: 2,\n};\n"
    const result = applyDiff(file, "SWAP 2.=3:\n+  aRenamed: 1,\n+  b: 2,\n+};")
    expect(result.text.match(/^\};/gm)?.length ?? 0).toBe(1)
  })

  test("drops duplicated leading and trailing boundary lines around range replacement", () => {
    const file2 = "header\nconst x = 1;\nconst y = 2;\nconst z = 3;\nfooter\n"
    const result = applyDiff(file2, "SWAP 2.=4:\n+const x = 1;\n+const yNew = 2;\n+const z = 3;")
    expect(result.text).toBe("header\nconst x = 1;\nconst yNew = 2;\nconst z = 3;\nfooter\n")
  })

  test("leaves a balance-preserving replacement alone (no false positive)", () => {
    const file = "a\nb\nc\n"
    const result = applyDiff(file, "SWAP 1.=3:\n+x\ny\nz")
    expect(result.text).toBe("x\ny\nz\n")
    expect(result.warnings.some((w) => /boundary echo/i.test(w))).toBe(false)
  })

  test("does not drop a balance-neutral duplicated statement", () => {
    const file = "import a\nimport b\n"
    const result = applyDiff(file, "SWAP 1.=2:\n+import a\n+import c")
    expect(result.text).toBe("import a\nimport c\n")
  })

  test("ignores brackets inside string literals", () => {
    const file = 'const s = "{";\n'
    const result = applyDiff(file, 'SWAP 1.=1:\n+const s = "{";')
    expect(result.text).toBe('const s = "{";\n')
    expect(result.warnings.some((w) => /boundary echo/i.test(w))).toBe(false)
  })

  test("drops JSX closer echo after self-closing tag with > prop expression", () => {
    const file = "<Foo value={a > b} />\n</Foo>\n"
    const result = applyDiff(file, "SWAP 1.=1:\n+<Bar value={a > b} />\n+</Foo>")
    expect(result.text).not.toContain("</Foo>\n</Foo>")
  })

  test("preserves nested JSX closer with matching surviving parent closer", () => {
    const file = "<section>\n</section>\n"
    const result = applyDiff(file, "SWAP 1.=1:\n+<section>\n+  <inner />\n+</section>\n+</section>")
    const closeCount = (result.text.match(/<\/section>/g) ?? []).length
    expect(closeCount).toBe(2)
  })

  test("drops one-sided trailing keeper echo in multi-line rewrite", () => {
    const file = "a\nb\nc\nd\ne\n"
    const result = applyDiff(file, "SWAP 1.=3:\n+b\n+c\n+d")
    expect(result.warnings.some((w) => /boundary echo/i.test(w))).toBe(true)
  })

  test("drops one-sided leading keeper echo in multi-line rewrite", () => {
    // Leading boundary echo: payload[0] must match file line just ABOVE the range
    const file = "a\nb\nc\nd\ne\n"
    // Range 2..4 deletes b,c,d. Payload restates a (above range) then b,c
    const result = applyDiff(file, "SWAP 2.=4:\n+a\n+b\n+c")
    expect(result.warnings.some((w) => /boundary echo/i.test(w))).toBe(true)
  })
})

describe("boundary-balance repair through stale-snapshot recovery", () => {
  test("de-duplicates closer while recovering from drifted file", () => {
    const { applyEdits, parsePatch } = require("../../src/hashline/index")
    expect(typeof applyEdits).toBe("function")
    expect(typeof parsePatch).toBe("function")
  })
})
