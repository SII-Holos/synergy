/** @param {string} name @param {"core" | "full"} [profile] */
function requiredRuntimeArtifactPaths(name, profile = "full") {
  const match = /^synergy-(linux|darwin|windows)-(x64|arm64)(?:-|$)/.exec(name)
  if (!match) throw new Error(`Invalid Synergy runtime package name: ${name}`)
  const [, os, arch] = match
  const musl = name.split("-").includes("musl")
  const modules = "runtime/node_modules/"
  const native = `${modules}@ericsanchezok/synergy-native-${os === "windows" ? "win32" : os}-${arch}${os === "linux" ? (musl ? "-musl" : "-glibc") : ""}`
  const library = `${modules}@ericsanchezok/synergy-library/dist/lib/onnxruntime-web`
  const svg = `${modules}@ericsanchezok/synergy-connections/dist/lib/resvg-wasm`
  const ast = os === "windows" ? `win32-${arch}-msvc` : os === "linux" ? `linux-${arch}-gnu` : `${os}-${arch}`
  const extension = os === "windows" ? "dll" : os === "darwin" ? "dylib" : "so"
  return [
    os === "windows" ? "bin/synergy.exe" : "bin/synergy",
    "runtime/generation.json",
    "runtime-assets.txt",
    `${modules}@ericsanchezok/synergy-cli/dist/modules/index.js`,
    `${modules}@ericsanchezok/synergy-harness/package.json`,
    `${native}/package.json`,
    `${native}/watcher.node`,
    `${native}/${os === "windows" ? "synergy_pty.dll" : `libsynergy_pty.${extension}`}`,
    `${native}/PTY-LICENSE`,
    ...(os === "darwin"
      ? [`${native}/libsqlite3.dylib`]
      : [`${native}/sandbox.json`, `${native}/synergy-sandbox-${os}${os === "windows" ? ".exe" : ""}`]),
    ...(profile === "full"
      ? [
          `${modules}@ericsanchezok/synergy-web-app/app/index.html`,
          ...["package.json", "index.js", "lib/coreBundle.js"].map((file) => `${modules}playwright-core/${file}`),
          `${library}/ort-wasm-simd-threaded.asyncify.mjs`,
          `${library}/ort-wasm-simd-threaded.asyncify.wasm`,
          ...[
            "index_bg.wasm",
            "LICENSE-MPL-2.0.txt",
            "THIRD_PARTY_NOTICES.txt",
            "fonts/LICENSE-OFL-1.1.txt",
            "fonts/noto-sans-sc-chinese-simplified-400-normal.woff2",
            "fonts/noto-sans-sc-latin-400-normal.woff2",
          ].map((file) => `${svg}/${file}`),
          `${modules}@sii-holos/holos-cli/dist/index.js`,
          `${modules}@sii-holos/holos-cli/dist/vendor/clarus-shared/index.js`,
          ...(!musl
            ? [
                `${modules}@ast-grep/cli-${ast}/ast-grep${os === "windows" ? ".exe" : ""}`,
                `${modules}sqlite-vec-${os}-${arch}/vec0.${extension}`,
              ]
            : []),
        ]
      : []),
  ]
}

exports.requiredRuntimeArtifactPaths = requiredRuntimeArtifactPaths
