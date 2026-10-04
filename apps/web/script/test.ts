#!/usr/bin/env bun

import path from "node:path"
import { runBatchedTests } from "../../../script/shared/test-runner"
import { testOptions } from "./test-options"

const root = path.resolve(import.meta.dir, "..")

await runBatchedTests({ ...testOptions, root })
