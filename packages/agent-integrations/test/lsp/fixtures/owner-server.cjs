let buffer = Buffer.alloc(0)
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
function handle(message) {
  if (message.method === "exit") return process.exit(0)
  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    send({
      method: "textDocument/publishDiagnostics",
      params: {
        uri: message.params.textDocument.uri,
        diagnostics: [{ range, severity: 2, message: "fixture warning", source: "fixture" }],
      },
    })
  }
  if (message.id === undefined) return
  const uri = message.params?.textDocument?.uri ?? "file:///fixture"
  const item = { name: "ownerSymbol", kind: 12, uri, range, selectionRange: range }
  let result = null
  if (message.method === "initialize")
    result = { capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true } }
  else if (message.method === "textDocument/hover") result = { contents: "fixture hover" }
  else if (
    ["textDocument/definition", "textDocument/references", "textDocument/implementation"].includes(message.method)
  )
    result = [{ uri, range }]
  else if (message.method === "textDocument/prepareCallHierarchy") result = [item]
  else if (message.method === "callHierarchy/incomingCalls") result = [{ from: item, fromRanges: [range] }]
  else if (message.method === "callHierarchy/outgoingCalls") result = [{ to: item, fromRanges: [range] }]
  else if (message.method === "textDocument/documentSymbol") result = [item]
  else if (message.method === "workspace/symbol")
    result = Array.from({ length: 12 }, (_, index) => ({ name: `symbol${index}`, kind: 12, location: { uri, range } }))
  send({ id: message.id, result })
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const split = buffer.indexOf("\r\n\r\n")
    if (split < 0) break
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString())?.[1])
    if (!Number.isFinite(length) || buffer.length < split + 4 + length) break
    const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString())
    buffer = buffer.subarray(split + 4 + length)
    handle(message)
  }
})
