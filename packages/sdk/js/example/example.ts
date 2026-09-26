import { createSynergy } from "@ericsanchezok/synergy-sdk"
import path from "node:path"
import { pathToFileURL } from "node:url"

const files = process.argv.slice(2)
if (!files.length) throw new Error("Pass the source files to process as command-line arguments")

const executable = process.env.SYNERGY_EXECUTABLE
const version = process.env.SYNERGY_VERSION
if (!executable || !version)
  throw new Error("Set SYNERGY_EXECUTABLE to the installed binary and SYNERGY_VERSION to its exact version")
const { server, client } = await createSynergy({
  mode: "managed",
  executable,
  version,
  home: path.resolve(".agent-data"),
  components: { server: version },
  client: { directory: process.cwd() },
})
try {
  for (const file of files) {
    const session = await client.session.create()
    if (!session.data) throw new Error(`Could not create a session for ${file}`)
    console.log("processing", file)
    const response = await client.session.prompt({
      sessionID: session.data.id,
      parts: [
        { type: "file", mime: "text/plain", url: pathToFileURL(path.resolve(file)).href },
        { type: "text", text: "Write tests for every public function in this file." },
      ],
    })
    if (response.error) throw new Error(`Prompt failed for ${file}: ${JSON.stringify(response.error)}`)
    console.log("done", file)
  }
} finally {
  await server.close()
}
