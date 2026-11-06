#!/usr/bin/env bun
import path from "node:path"
import { generateSchema } from "../../../script/release/shared/build-runtime"

const directory = path.resolve(import.meta.dir, "..")
await generateSchema(directory, "full")
console.log(`wrote config schema to ${path.join(directory, "schema/config.schema.json")}`)
