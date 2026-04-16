import { defineConfig } from "vite"
import appPlugin from "./vite"

export default defineConfig({
  base: "./",
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
})
