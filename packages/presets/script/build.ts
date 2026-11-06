#!/usr/bin/env bun
import { buildRuntime } from "../../../script/release/shared/build-runtime"

export const binaries = await buildRuntime("full")
