import { defineConfig, loadEnv } from "vite"
import appPlugin from "./vite"

function envFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const hosted = envFlag(env.VITE_SYNERGY_HOSTED)

  return {
    base: hosted ? "/" : "./",
    plugins: [appPlugin] as any,
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      port: 3000,
    },
    build: {
      target: "esnext",
      // sourcemap: true,
    },
  }
})
