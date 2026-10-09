import { expect, test } from "bun:test"
import { getEncoding } from "js-tiktoken"
import { Token } from "../../src/util/token"

for (const model of ["gpt-4", "gpt-4o"]) {
  test(`${model} selective loading preserves exact multilingual token counts`, async () => {
    const reference = getEncoding(Token.encodingForModelID(model))
    const inputs = [
      "hi",
      "你好，实验方案📊",
      "const sample = { temperature: 800, unit: '°C' }",
      "",
      "a\u0301🙂\n\t",
      "<|endoftext|>",
      "<|fim_prefix|>prefix<|fim_middle|>suffix<|fim_suffix|>",
      "مرحبا بالعالم 日本語 실험 계획",
      "\ud800\udc00\ud800",
      ...Array.from(
        { length: 100 },
        (_, index) => `试验 ${index}: ${"a\u0301🧪; temperature=800°C\n".repeat(index + 1)}`,
      ),
    ]
    const counts = await Promise.all(inputs.map((input) => Token.countModel(model, input)))
    for (const [index, input] of inputs.entries()) {
      let expected: number | undefined
      try {
        expected = reference.encode(input).length
      } catch {
        expected = undefined
      }
      expect(counts[index]).toBe(expected)
      expect(Token.estimateModelSync(model, input)).toBe(expected ?? Token.estimate(input))
    }
  })
}
