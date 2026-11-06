const prompt = await Bun.stdin.text()
await Bun.write(
  "invocation.json",
  JSON.stringify({
    args: process.argv.slice(2),
    prompt,
    apiKey: process.env.SYNERGY_CODEX_API_KEY ?? null,
    unforwarded: process.env.UNFORWARDED_FIXTURE_VALUE ?? null,
  }),
)
process.stderr.write("Reading additional input from stdin...\nfixture diagnostic\n")
process.stdout.write("fixture banner\n\n")
const events = [
  { type: "thread.started", thread_id: "thread-fixture" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "shell-1", type: "command_execution", command: "fixture command" } },
  {
    type: "item.completed",
    item: { id: "shell-1", type: "command_execution", aggregated_output: "fixture output", exit_code: 2 },
  },
  {
    type: "item.completed",
    item: {
      id: "message-1",
      type: "agent_message",
      content: [{ type: "output_text", text: "Fixture answer" }],
    },
  },
  { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 7 } },
]
process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n"))

export {}
