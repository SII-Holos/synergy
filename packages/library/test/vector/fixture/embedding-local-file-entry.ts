import fs from "node:fs"
import { pathToFileURL } from "node:url"
import { loadEmbeddingTransformersRuntime } from "../../../src/vector/embedding-runtime"

const probeFile = process.argv[2]
if (!probeFile) throw new Error("missing probe file argument")

const loaded = await loadEmbeddingTransformersRuntime()
const runtime = loaded.runtime

const expected = fs.readFileSync(probeFile, "utf8")
const viaFileUrl = await fetch(pathToFileURL(probeFile).href)
const viaFileUrlText = await viaFileUrl.text()
const viaRawPath = await fetch(probeFile)
const viaRawPathText = await viaRawPath.text()

if (viaFileUrlText !== expected) throw new Error("file:// fetch returned unexpected content")
if (viaRawPathText !== expected) throw new Error("raw path fetch returned unexpected content")

console.log("standalone local file fetch ready")
