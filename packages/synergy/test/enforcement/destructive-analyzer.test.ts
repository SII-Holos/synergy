import { describe, test, expect } from "bun:test"
import { analyzeDestructiveCommand, splitCompoundCommands, stripWrappers } from "@/enforcement/gate"

describe("splitCompoundCommands", () => {
  test("splits on &&", () => {
    expect(splitCompoundCommands("rm -rf / && echo done")).toHaveLength(2)
  })

  test("splits on ||", () => {
    expect(splitCompoundCommands("cmd1 || cmd2")).toHaveLength(2)
  })

  test("splits on ;", () => {
    expect(splitCompoundCommands("cmd1 ; cmd2")).toHaveLength(2)
  })

  test("splits on |", () => {
    expect(splitCompoundCommands("cmd1 | cmd2")).toHaveLength(2)
  })

  test("does NOT split inside single quotes", () => {
    expect(splitCompoundCommands("echo 'a && b'")).toHaveLength(1)
  })

  test("does NOT split inside double quotes", () => {
    expect(splitCompoundCommands('echo "a && b"')).toHaveLength(1)
  })

  test("handles mixed quotes and operators", () => {
    const parts = splitCompoundCommands("echo 'hello' && echo \"world && test\" ; echo done")
    expect(parts).toHaveLength(3)
  })
})

describe("stripWrappers", () => {
  test("strips timeout with numeric arg", () => {
    expect(stripWrappers("timeout 10 rm -rf /").trim()).toBe("rm -rf /")
  })

  test("strips sudo", () => {
    expect(stripWrappers("sudo rm -rf /").trim()).toBe("rm -rf /")
  })

  test("strips nice (leaves -n flag's value as heuristic limitation)", () => {
    // nice -n 10 cmd: strips "nice", then "-n" (flag), leaves "10 cmd"
    // The heuristic strips one wrapper-arg token only, not the value after a flag.
    const result = stripWrappers("nice -n 10 cmd").trim()
    expect(result).toBe("10 cmd")
  })

  test("strips nohup", () => {
    expect(stripWrappers("nohup cmd").trim()).toBe("cmd")
  })

  test("strips nested wrappers", () => {
    expect(stripWrappers("sudo timeout 5 rm -rf /").trim()).toBe("rm -rf /")
  })

  test("does not strip non-wrapper commands", () => {
    expect(stripWrappers("rm -rf /").trim()).toBe("rm -rf /")
  })

  test("handles empty string", () => {
    expect(stripWrappers("").trim()).toBe("")
  })
})

describe("analyzeDestructiveCommand", () => {
  test("detects rm -rf", () => {
    const r = analyzeDestructiveCommand("rm -rf /")
    expect(r.matched).toBe(true)
    expect(r.reason).toContain("rm")
  })

  test("detects rm with extra spaces (bypasses old includes() check)", () => {
    expect(analyzeDestructiveCommand("rm  -rf  /").matched).toBe(true)
    expect(analyzeDestructiveCommand("rm   -rf   /").matched).toBe(true)
  })

  test("detects rm targeting root", () => {
    expect(analyzeDestructiveCommand("rm -rf /").matched).toBe(true)
  })

  test("detects rm targeting home", () => {
    expect(analyzeDestructiveCommand("rm -rf ~/*").matched).toBe(true)
  })

  test("detects rm with wildcard", () => {
    expect(analyzeDestructiveCommand("rm -rf ./*").matched).toBe(true)
  })

  test("detects git push --force", () => {
    expect(analyzeDestructiveCommand("git push origin main --force").matched).toBe(true)
  })

  test("detects git push -f", () => {
    expect(analyzeDestructiveCommand("git push -f origin main").matched).toBe(true)
  })

  test("detects git reset --hard", () => {
    expect(analyzeDestructiveCommand("git reset --hard HEAD~3").matched).toBe(true)
  })

  test("detects git clean -d", () => {
    expect(analyzeDestructiveCommand("git clean -fd").matched).toBe(true)
  })

  test("detects in compound command (&&)", () => {
    const r = analyzeDestructiveCommand("echo hello && rm -rf /tmp/foo")
    expect(r.matched).toBe(true)
  })

  test("detects in compound command (||)", () => {
    expect(analyzeDestructiveCommand("cmd1 || rm -rf /").matched).toBe(true)
  })

  test("detects under wrapper (sudo timeout)", () => {
    expect(analyzeDestructiveCommand("sudo timeout 10 rm -rf /var/log").matched).toBe(true)
  })

  test("detects shred", () => {
    expect(analyzeDestructiveCommand("shred -u secret.txt").matched).toBe(true)
  })

  test("detects dd to device", () => {
    expect(analyzeDestructiveCommand("dd if=/dev/zero of=/dev/sda").matched).toBe(true)
  })

  test("detects mkfs", () => {
    expect(analyzeDestructiveCommand("mkfs.ext4 /dev/sda1").matched).toBe(true)
  })

  test("detects find -delete", () => {
    expect(analyzeDestructiveCommand("find /tmp -name '*.log' -delete").matched).toBe(true)
  })

  test("detects find -exec rm", () => {
    expect(analyzeDestructiveCommand("find /tmp -exec rm {} \\;").matched).toBe(true)
  })

  test("detects chmod on root", () => {
    expect(analyzeDestructiveCommand("chmod -R 777 /").matched).toBe(true)
  })

  test("does NOT flag safe commands", () => {
    expect(analyzeDestructiveCommand("ls -la").matched).toBe(false)
    expect(analyzeDestructiveCommand("git status").matched).toBe(false)
    expect(analyzeDestructiveCommand("npm run build").matched).toBe(false)
    expect(analyzeDestructiveCommand("echo hello").matched).toBe(false)
    expect(analyzeDestructiveCommand("cat file.txt").matched).toBe(false)
    expect(analyzeDestructiveCommand("grep pattern file").matched).toBe(false)
    expect(analyzeDestructiveCommand("node script.js").matched).toBe(false)
  })

  test("empty command is not destructive", () => {
    expect(analyzeDestructiveCommand("").matched).toBe(false)
    expect(analyzeDestructiveCommand("   ").matched).toBe(false)
  })

  test("returns reason and pattern on match", () => {
    const r = analyzeDestructiveCommand("rm -rf /")
    expect(r.matched).toBe(true)
    expect(typeof r.reason).toBe("string")
    expect(r.reason!.length).toBeGreaterThan(0)
  })
})
