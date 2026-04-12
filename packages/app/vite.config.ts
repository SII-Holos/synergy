import { defineConfig, loadEnv } from "vite"
import appPlugin from "./vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const hosted = env.VITE_SYNERGY_HOSTED === "1" || env.VITE_SYNERGY_HOSTED === "true"

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
