import fs from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
if (process.argv[2] === "format") {
  const file = process.argv[3]!
  const before = fs.readFileSync(file, "utf8")
  const after = before.trimEnd() + "\n"
  fs.writeFileSync(file, after)
  fs.writeFileSync(
    file + ".formatter.json",
    JSON.stringify({ pid: process.pid, before: hash(before), after: hash(after) }),
  )
} else if (process.argv[2] === "lsp") {
  let buffer = Buffer.alloc(0)
  const documents = new Map<string, string>()
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  fs.writeFileSync("lsp.pid", String(process.pid))
  function send(message: object) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message })
    fs.appendFileSync("lsp-transport.ndjson", JSON.stringify({ direction: "out", message }) + "\n")
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  type Request = {
    id?: number | string
    method: string
    params?: { textDocument?: { uri: string; text?: string }; contentChanges?: Array<{ text: string }> }
  }
  function handle(message: Request) {
    fs.appendFileSync("lsp-transport.ndjson", JSON.stringify({ direction: "in", message }) + "\n")
    if (message.method === "exit") process.exit(0)
    const uri = message.params?.textDocument?.uri
    if (uri && ["textDocument/didOpen", "textDocument/didChange"].includes(message.method)) {
      const text = message.params?.textDocument?.text ?? message.params?.contentChanges?.[0]?.text
      if (text === undefined) throw new Error("Language service did not receive document bytes")
      const physical = fs.readFileSync(fileURLToPath(uri), "utf8")
      if (text !== physical) throw new Error("Language service document differs from selected physical bytes")
      documents.set(uri, hash(physical))
      send({
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [{ range, severity: 2, message: hash(physical), source: "acceptance" }] },
      })
    }
    if (message.id === undefined) return
    let result: unknown = null
    if (message.method === "initialize") result = { capabilities: { textDocumentSync: 1, hoverProvider: true } }
    if (message.method === "textDocument/hover") {
      if (!uri || !documents.has(uri)) throw new Error("Hover precedes document delivery")
      result = { contents: hash(fs.readFileSync(fileURLToPath(uri), "utf8")) }
    }
    send({ id: message.id, result })
  }
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const split = buffer.indexOf("\r\n\r\n")
      if (split < 0) return
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString())?.[1])
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid language protocol frame")
      if (buffer.length < split + 4 + length) return
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()) as Request
      buffer = buffer.subarray(split + 4 + length)
      handle(message)
    }
  })
} else throw new Error("Select an explicit acceptance process role")
