import { expect, test } from "bun:test"
import { getEncoding } from "js-tiktoken"
import { Token } from "../../src/util/token"

test("a fresh process uses the heuristic until its selected encoder is warm", async () => {
  const script = `
    import { Token } from ${JSON.stringify(new URL("../../src/util/token.ts", import.meta.url).href)};
    const input = "这是一个中文测试";
    const before = Token.estimateModelSync("gpt-4-turbo", input);
    await Token.warmup("gpt-4-turbo");
    console.log(JSON.stringify({ before, after: Token.estimateModelSync("gpt-4-turbo", input) }));
  `
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.before).toBe(Token.estimate("这是一个中文测试"))
    expect(result.after).toBeGreaterThan(result.before)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
})

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
