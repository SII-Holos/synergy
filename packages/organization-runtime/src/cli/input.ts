import { z } from "zod"
import { MemberHomeError } from "../record"

export async function readMachineInput<T>(schema: z.ZodType<T>, label = "machine registration request") {
  const chunks: Buffer[] = []
  let bytes = 0
  const deadline = setTimeout(() => process.stdin.destroy(new Error("Machine input expired")), 15_000)
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 64 * 1024) throw new Error("Machine input exceeds its limit")
      chunks.push(buffer)
    }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  } catch {
    throw new MemberHomeError(`Invalid or incomplete ${label}`)
  } finally {
    clearTimeout(deadline)
  }
}
