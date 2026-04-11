import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), solidPlugin()],
  server: {
    port: 4500,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.VITE_API_PORT || 4501}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
})
