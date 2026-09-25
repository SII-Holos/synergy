const readline = require("node:readline")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  let result = {}
  if (message.method === "initialize")
    result = {
      protocolVersion: message.params.protocolVersion,
      serverInfo: { name: "installed-fixture", version: "1" },
      capabilities: { tools: {}, prompts: {}, resources: {} },
    }
  else if (message.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: "Echo input",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    }
  else if (message.method === "tools/call")
    result = { content: [{ type: "text", text: message.params.arguments.text }] }
  else if (message.method === "prompts/list") result = { prompts: [] }
  else if (message.method === "resources/list")
    result = { resources: [{ uri: "fixture://evidence", name: "evidence", mimeType: "text/plain" }] }
  else if (message.method === "resources/read")
    result = { contents: [{ uri: "fixture://evidence", mimeType: "text/plain", text: "installed MCP evidence" }] }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
})
