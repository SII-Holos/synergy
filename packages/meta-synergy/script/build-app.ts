#!/usr/bin/env bun

import { $ } from "bun"
import path from "node:path"
import fs from "node:fs/promises"

const pkgDir = path.resolve(import.meta.dir, "..")
const distDir = path.join(pkgDir, "dist", "app")
const appName = "MetaSynergy"
const darwinDir = path.join(pkgDir, "app", "darwin")
const sourcePath = path.join(darwinDir, "main.swift")
const appIconSourcePath = path.join(darwinDir, "assets", "app-icon.png")
const statusIconSourcePath = path.join(darwinDir, "assets", "status-icon.png")
const runtimeEntrypoint = path.join(pkgDir, "src", "cli.ts")
const signIdentity = process.env.METASYNERGY_SIGN_IDENTITY || "-"

const targets = [
  {
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    swiftTarget: "arm64-apple-macos12.0",
    suffix: "darwin-arm64",
  },
  {
    arch: "x64",
    bunTarget: "bun-darwin-x64",
    swiftTarget: "x86_64-apple-macos12.0",
    suffix: "darwin-x64",
  },
] as const

await $`rm -rf ${distDir}`

for (const target of targets) {
  await buildTarget(target)
}

if (signIdentity === "-") {
  console.log(
    "Note: this build uses ad-hoc signing. Gatekeeper may reject it until you sign/notarize with a Developer ID.",
  )
}

async function buildTarget(target: (typeof targets)[number]) {
  const targetDir = path.join(distDir, target.suffix)
  const appDir = path.join(targetDir, `${appName}.app`)
  const contentsDir = path.join(appDir, "Contents")
  const macOSDir = path.join(contentsDir, "MacOS")
  const resourcesDir = path.join(contentsDir, "Resources")
  const appExecutable = path.join(macOSDir, appName)
  const runtimeExecutable = path.join(resourcesDir, "meta-synergy-runtime")
  const infoPlistPath = path.join(contentsDir, "Info.plist")
  const dmgPath = path.join(distDir, `${appName}-${target.suffix}.dmg`)
  const tempDir = path.join(targetDir, ".tmp")
  const iconsetDir = path.join(tempDir, "AppIcon.iconset")
  const moduleCacheDir = path.join(tempDir, "swift-module-cache")

  await fs.mkdir(macOSDir, { recursive: true })
  await fs.mkdir(resourcesDir, { recursive: true })
  await fs.mkdir(tempDir, { recursive: true })
  await fs.mkdir(moduleCacheDir, { recursive: true })

  console.log(`Building embedded MetaSynergy runtime (${target.suffix})`)
  const result = await Bun.build({
    entrypoints: [runtimeEntrypoint],
    target: "bun",
    sourcemap: "none",
    minify: false,
    compile: {
      target: target.bunTarget,
      outfile: runtimeExecutable,
      execArgv: ["--use-system-ca", "--"],
    },
  })

  if (!result.success) {
    throw new Error(
      `Failed to build runtime for ${target.suffix}:\n${result.logs.map((log) => log.message).join("\n")}`,
    )
  }

  await $`chmod +x ${runtimeExecutable}`

  console.log(`Compiling native macOS menu bar host (${target.suffix})`)
  await $`env CLANG_MODULE_CACHE_PATH=${moduleCacheDir} swiftc -target ${target.swiftTarget} -O ${sourcePath} -o ${appExecutable}`

  const iconBuilt = await buildIcon(iconsetDir, resourcesDir).catch((error) => {
    console.warn(
      `Icon generation skipped for ${target.suffix}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  })
  await $`cp ${statusIconSourcePath} ${path.join(resourcesDir, "StatusIcon.png")}`

  await fs.writeFile(
    infoPlistPath,
    plist({
      executable: appName,
      iconFile: iconBuilt ? "AppIcon" : undefined,
    }),
  )

  console.log(`Applying code signature (${signIdentity === "-" ? "ad-hoc" : signIdentity}) to ${target.suffix}`)
  await $`codesign --force --deep --sign ${signIdentity} ${appDir}`.quiet().catch((error) => {
    console.warn(`codesign skipped for ${target.suffix}: ${error}`)
  })

  console.log(`Building DMG (${target.suffix})`)
  const dmgStageDir = path.join(tempDir, "dmg")
  await fs.mkdir(dmgStageDir, { recursive: true })
  await $`cp -R ${appDir} ${dmgStageDir}`
  await $`ln -s /Applications ${path.join(dmgStageDir, "Applications")}`
  await $`hdiutil create -volname ${appName} -srcfolder ${dmgStageDir} -ov -format UDZO ${dmgPath}`.quiet()

  console.log(`Built ${appDir}`)
  console.log(`Built ${dmgPath}`)
}

async function buildIcon(iconsetDir: string, resourcesDir: string) {
  await fs.mkdir(iconsetDir, { recursive: true })
  const tempDir = path.dirname(iconsetDir)
  const flattenedJPG = path.join(tempDir, "app-icon-white.jpg")
  const sourcePNG = path.join(tempDir, "app-icon-white.png")
  await $`sips -s format jpeg ${appIconSourcePath} --out ${flattenedJPG}`.quiet()
  await $`sips -s format png ${flattenedJPG} --out ${sourcePNG}`.quiet()

  const sizes = [
    ["16", "icon_16x16.png"],
    ["32", "icon_16x16@2x.png"],
    ["32", "icon_32x32.png"],
    ["64", "icon_32x32@2x.png"],
    ["128", "icon_128x128.png"],
    ["256", "icon_128x128@2x.png"],
    ["256", "icon_256x256.png"],
    ["512", "icon_256x256@2x.png"],
    ["512", "icon_512x512.png"],
    ["1024", "icon_512x512@2x.png"],
  ] as const

  for (const [size, filename] of sizes) {
    await $`sips -z ${size} ${size} ${sourcePNG} --out ${path.join(iconsetDir, filename)}`.quiet()
  }

  await $`iconutil -c icns ${iconsetDir} -o ${path.join(resourcesDir, "AppIcon.icns")}`.quiet()
  return true
}

function plist(input: { executable: string; iconFile?: string }) {
  const iconLine = input.iconFile ? `  <key>CFBundleIconFile</key>\n  <string>${input.iconFile}</string>\n` : ""
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>MetaSynergy</string>
  <key>CFBundleExecutable</key>
  <string>${input.executable}</string>
  <key>CFBundleIdentifier</key>
  <string>io.holos.metasynergy</string>
${iconLine}  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>MetaSynergy</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`
}
