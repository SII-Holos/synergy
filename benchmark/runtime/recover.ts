import { exportRollout } from "./export"
const [requestFile] = process.argv.slice(2)
const request = await Bun.file(requestFile).json()
const result = await exportRollout({
  logs: "/recovery/output",
  runtime: request.runtime,
  identity: request.identity,
  timeoutSeconds: request.timeout_seconds,
  env: {
    ...process.env,
    SYNERGY_HOME: "/recovery/home",
    SYNERGY_CONFIG: "/recovery/config.json",
    SYNERGY_CONFIG_CONTENT: "{}",
    SYNERGY_BENCH_COMPOSITION: request.runtime,
    SYNERGY_DISABLE_MODELS_FETCH: "1",
    SYNERGY_DISABLE_DEFAULT_PLUGINS: "1",
    SYNERGY_DISABLE_AUTOUPDATE: "1",
    MODELS_DEV_API_JSON: "/opt/synergy/source/packages/testing/fixtures/models-api.json",
  },
})
process.exit(result.status === "completed" ? 0 : 1)
