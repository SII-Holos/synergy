#!/usr/bin/env bun

import path from "node:path"
import { runBatchedTests } from "../../../script/shared/test-runner"
import { testOptions } from "./test-options"
import { prepareDOMFixtures } from "../test/support/dom-fixtures"

const root = path.resolve(import.meta.dir, "..")

await prepareDOMFixtures()
await runBatchedTests({ ...testOptions, root })
