import { heapStats } from "bun:jsc"
import { preview } from "../../src/execution/preview"

function retainPreviews() {
  const pattern = process.argv[2] === "utf16" ? "汉字  🌏\n" : "abc  def\n"
  const previews: string[] = []
  for (let index = 0; index < 32; index++) {
    const source = `${index}:${pattern.repeat(131_072)}:${index}`
    previews.push(preview(source))
  }
  return previews
}

Bun.gc(true)
const baseline = heapStats().extraMemorySize
const previews = retainPreviews()
Bun.gc(true)
console.log(
  JSON.stringify({
    retainedBytes: heapStats().extraMemorySize - baseline,
    previewChars: previews.reduce((total, value) => total + value.length, 0),
  }),
)
