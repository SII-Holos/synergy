#!/usr/bin/env bun

import { $ } from "bun"

await $`bun run prettier --ignore-unknown --cache --cache-strategy content --write .`
