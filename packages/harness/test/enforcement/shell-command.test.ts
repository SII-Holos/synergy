import { describe, test, expect } from "bun:test"
import { splitCompoundCommands, stripWrappers } from "../../src/enforcement/shell-command"
import { lexCompoundCommands } from "../../src/enforcement/shell-command"

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

  test("uses longest-match rules for every supported compound operator", () => {
    const lexed = lexCompoundCommands("a && b || c |& d | e ;;& f ;; g ;& h ; i & j")

    expect(lexed.operators).toEqual(["&&", "||", "|&", "|", ";;&", ";;", ";&", ";", "&"])
    expect(lexed.segments).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])
  })

  test("does not treat quoted, escaped, or redirect operators as compound operators", () => {
    const command = String.raw`echo "|&" '\;' \| 2>&1 &>output >| clobbered`
    const lexed = lexCompoundCommands(command)
    expect(lexed.operators).toEqual([])
    expect(lexed.segments).toEqual([command])
  })
})

describe("lexCompoundCommands newline and heredoc", () => {
  test("treats unquoted newlines as list boundaries without trailing phantom operators", () => {
    expect(lexCompoundCommands("echo one\n\necho two\n")).toEqual({
      segments: ["echo one", "echo two"],
      operators: [";"],
    })
  })

  test("skips comment-only lines without changing read-only command segments", () => {
    expect(lexCompoundCommands("pwd\n# note\npwd")).toEqual({
      segments: ["pwd", "pwd"],
      operators: [";"],
    })
  })

  test("preserves quoted newlines inside one segment", () => {
    const command = "printf '%s' 'one\ntwo'"
    expect(lexCompoundCommands(command)).toEqual({ segments: [command], operators: [] })
  })

  test("keeps escaped newlines inside the current command word", () => {
    const command = String.raw`su\
do make install`
    expect(lexCompoundCommands(command)).toEqual({ segments: [command], operators: [] })
  })

  test.each(["'EOF'", '"EOF"', String.raw`\EOF`])("preserves heredoc bodies using delimiter %s", (delimiter) => {
    const command = `cat <<${delimiter}\na; b | c\nEOF\necho done`
    expect(lexCompoundCommands(command)).toEqual({
      segments: [`cat <<${delimiter}\na; b | c\nEOF`, "echo done"],
      operators: [";"],
    })
  })

  test("supports tab-stripped and multiple heredocs", () => {
    const tabStripped = "cat <<-EOF\n\tvalue\n\tEOF\necho done"
    expect(lexCompoundCommands(tabStripped)).toEqual({
      segments: ["cat <<-EOF\n\tvalue\n\tEOF", "echo done"],
      operators: [";"],
    })

    const multiple = "cat <<A <<B\nbody-a\nA\nbody-b\nB\necho done"
    expect(lexCompoundCommands(multiple)).toEqual({
      segments: ["cat <<A <<B\nbody-a\nA\nbody-b\nB", "echo done"],
      operators: [";"],
    })
  })

  test("supports multiple quoted heredoc delimiters", () => {
    const quotedMultiple = "cat <<'A' <<\"B\"\nbody-a\nA\nbody-b\nB\necho done"
    expect(lexCompoundCommands(quotedMultiple)).toEqual({
      segments: ["cat <<'A' <<\"B\"\nbody-a\nA\nbody-b\nB", "echo done"],
      operators: [";"],
    })
  })

  test("does not treat herestrings as heredocs and preserves unterminated bodies", () => {
    expect(lexCompoundCommands("cat <<<EOF\necho done")).toEqual({
      segments: ["cat <<<EOF", "echo done"],
      operators: [";"],
    })

    const unterminated = "cat <<EOF\nbody\nstill body"
    expect(lexCompoundCommands(unterminated)).toEqual({ segments: [unterminated], operators: [] })
  })
  test("does not treat arithmetic left shifts as heredoc headers", () => {
    for (const command of [
      "echo $((a << b))\nsudo make install",
      "((a << b))\nsudo make install",
      "echo $[a << b]\nsudo make install",
    ]) {
      expect(lexCompoundCommands(command)).toEqual({
        segments: [command.slice(0, command.indexOf("\n")), "sudo make install"],
        operators: [";"],
      })
    }
  })

  test("preserves multiline arithmetic and quoted strings before later commands", () => {
    for (const command of [
      "echo $((\n1 << 2\n))\nsudo make install",
      "((\n1 << 2\n))\nsudo make install",
      "echo $[\n1 << 2\n]\nsudo make install",
      "echo 'a\n<< b'\nsudo make install",
      'echo "a\n<< b"\nsudo make install',
    ]) {
      expect(lexCompoundCommands(command)).toEqual({
        segments: [command.slice(0, command.lastIndexOf("\n")), "sudo make install"],
        operators: [";"],
      })
    }
  })

  test("recognizes arithmetic commands immediately after reserved words", () => {
    expect(lexCompoundCommands("if :; then((a << b)); fi\nsudo make install")).toEqual({
      segments: ["if :", "then((a << b))", "fi", "sudo make install"],
      operators: [";", ";", ";"],
    })
  })

  test("does not treat heredoc syntax inside comments as a header", () => {
    for (const command of ["echo hi # << EOF\nsudo make install", "echo hi # << EOF body\nsudoedit /etc/hosts"]) {
      expect(lexCompoundCommands(command)).toEqual({
        segments: [command.slice(0, command.indexOf("\n")), command.slice(command.indexOf("\n") + 1)],
        operators: [";"],
      })
    }

    expect(lexCompoundCommands("# note << EOF\nsudo make install")).toEqual({
      segments: ["sudo make install"],
      operators: [],
    })
  })

  test("distinguishes comments after commands from literal hashes after expansions", () => {
    for (const command of ["((1))# << EOF\nsudo make install", "(printf x)# << EOF\nsudo make install"]) {
      expect(lexCompoundCommands(command)).toEqual({
        segments: [command.slice(0, command.indexOf("\n")), command.slice(command.indexOf("\n") + 1)],
        operators: [";"],
      })
    }

    for (const command of [
      "echo $((1))# <<EOF\nsudo make install\nEOF",
      "echo $(printf x)# <<EOF\nsudo make install\nEOF",
    ]) {
      expect(lexCompoundCommands(command)).toEqual({ segments: [command], operators: [] })
    }
  })

  test("keeps a real heredoc when its header has a trailing comment", () => {
    const heredoc = "cat <<EOF # <<FAKE\nsudo make install\nEOF"
    expect(lexCompoundCommands(`${heredoc}\nsudoedit /etc/hosts`)).toEqual({
      segments: [heredoc, "sudoedit /etc/hosts"],
      operators: [";"],
    })
  })

  test("keeps comment markers and sudo text inside heredoc bodies inert", () => {
    const command = "cat <<EOF\n# << INNER\nsudo make install\nEOF"
    expect(lexCompoundCommands(command)).toEqual({ segments: [command], operators: [] })
  })

  test("preserves an unquoted command substitution containing a heredoc", () => {
    const substitution = "echo $(cat <<EOF\nvalue\nEOF\n)"
    expect(lexCompoundCommands(`${substitution}\necho done`)).toEqual({
      segments: [substitution, "echo done"],
      operators: [";"],
    })
  })

  test("keeps a heredoc body attached when its header has a trailing operator", () => {
    const command = "cat <<EOF && echo ok\nbody\nEOF\necho done"
    expect(lexCompoundCommands(command)).toEqual({
      segments: ["cat <<EOF\nbody\nEOF", "echo ok", "echo done"],
      operators: ["&&", ";"],
    })
  })

  test("preserves newlines inside legacy backtick substitutions", () => {
    const substitution = "x=`echo one\necho two`"
    expect(lexCompoundCommands(`${substitution}\necho done`)).toEqual({
      segments: [substitution, "echo done"],
      operators: [";"],
    })
  })

  test("does not rescan heredoc markers inside legacy backtick substitutions", () => {
    const command = "echo `printf <<EOF` && echo done\necho after"
    expect(lexCompoundCommands(command)).toEqual({
      segments: ["echo `printf <<EOF`", "echo done", "echo after"],
      operators: ["&&", ";"],
    })
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
