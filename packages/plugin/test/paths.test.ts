import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { synergyHome, synergyRoot, synergySigningKeyFile, synergySigningKeysDir } from "../src/paths"

describe("synergy paths", () => {
  test("synergyHome honors SYNERGY_HOME then SYNERGY_TEST_HOME then the OS home", () => {
    expect(synergyHome({ SYNERGY_HOME: "/home/a", SYNERGY_TEST_HOME: "/home/b" })).toBe("/home/a")
    expect(synergyHome({ SYNERGY_HOME: undefined, SYNERGY_TEST_HOME: "/home/b" })).toBe("/home/b")
    expect(synergyHome({ SYNERGY_HOME: undefined, SYNERGY_TEST_HOME: undefined })).toBe(os.homedir())
  })

  test("roots derive from the resolved home", () => {
    expect(synergyRoot({ SYNERGY_HOME: "/home/a" })).toBe(path.join("/home/a", ".synergy"))
    expect(synergySigningKeysDir({ SYNERGY_TEST_HOME: "/home/b" })).toBe(path.join("/home/b", ".synergy", "keys"))
    expect(synergySigningKeyFile({ SYNERGY_HOME: "/home/c" })).toBe(
      path.join("/home/c", ".synergy", "keys", "signing-key.json"),
    )
  })
})
