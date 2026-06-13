import readline from "node:readline"

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

// Render a clickable terminal hyperlink (OSC 8) when stdout is a TTY, so a long
// URL doesn't sit there as an unclickable wrapped string. Falls back to the raw
// URL when piped (or a terminal that ignores the escape still shows the text).
export const hyperlink = (url: string, text = url): string =>
  process.stdout.isTTY ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : url

// Wrap text in orange so copy-paste commands and links stand out. No-op when
// stdout isn't a TTY, so piped output stays free of escape codes.
export const orange = (s: string): string =>
  process.stdout.isTTY ? `\x1b[38;5;208m${s}\x1b[0m` : s

const setRaw = (on: boolean) => {
  const s: any = process.stdin
  if (s.isTTY && typeof s.setRawMode === "function") s.setRawMode(on)
}

// One-line reader that keeps any read-ahead in a shared buffer and pauses stdin
// between calls. A fresh readline interface per prompt would let the first one
// swallow later prompts' input (broken for pipes, fragile for pasted input).
let stdinBuffer = ""

const readLine = (query: string): Promise<string> =>
  new Promise((resolve) => {
    process.stdout.write(query)

    const take = () => {
      const i = stdinBuffer.indexOf("\n")
      if (i < 0) return false
      const line = stdinBuffer.slice(0, i).replace(/\r$/, "")
      stdinBuffer = stdinBuffer.slice(i + 1)
      resolve(line)
      return true
    }
    if (take()) return

    const onData = (d: Buffer) => {
      stdinBuffer += d.toString("utf8")
      if (stdinBuffer.includes("\n")) {
        process.stdin.off("data", onData)
        process.stdin.off("end", onEnd)
        process.stdin.pause()
        take()
      }
    }
    const onEnd = () => {
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
      const line = stdinBuffer.replace(/\r$/, "")
      stdinBuffer = ""
      resolve(line)
    }
    process.stdin.on("data", onData)
    process.stdin.on("end", onEnd)
    process.stdin.resume()
  })

export const promptText = async (query: string, def = ""): Promise<string> => {
  const answer = await readLine(`${query}${def ? ` [${def}]` : ""}: `)
  return answer.trim() || def
}

// Yes/No confirm rendered as an arrow-key selector: the default option is
// pre-highlighted (Enter keeps it), ↑/↓ flips it. Falls back to a [y/N] text
// reader when stdin isn't an interactive TTY (pipes, --yes flows, tests).
export const promptConfirm = async (query: string, def = false): Promise<boolean> => {
  if (!isInteractive()) {
    const answer = await readLine(`${query} [${def ? "Y/n" : "y/N"}]: `)
    const a = answer.trim().toLowerCase()
    return a ? a === "y" || a === "yes" : def
  }
  return selectOne(
    query,
    [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ],
    def ? 0 : 1,
  )
}

export const promptHidden = (query: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const output = (rl as any).output
    let started = false
    ;(rl as any)._writeToOutput = (chunk: string) => {
      if (!started) {
        output.write(chunk)
        if (chunk.includes(query)) started = true
        return
      }
      // mask everything typed after the prompt is shown
    }
    rl.question(query, (answer) => {
      output.write("\n")
      rl.close()
      resolve(answer.trim())
    })
  })

type Choice<T> = { label: string; value: T }

const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

// Arrow-key single select. Falls back to the first/initial choice when stdin
// isn't an interactive TTY (callers gate on isInteractive() before prompting).
export const selectOne = <T>(message: string, choices: Choice<T>[], initial = 0): Promise<T> =>
  new Promise((resolve) => {
    if (!isInteractive() || choices.length === 0) {
      resolve(choices[Math.min(initial, choices.length - 1)]?.value)
      return
    }
    let idx = Math.max(0, Math.min(initial, choices.length - 1))
    const out = process.stdout
    out.write(message + "\n")
    const render = (first: boolean) => {
      if (!first) out.write(`\x1b[${choices.length}A`)
      for (let i = 0; i < choices.length; i++) {
        const on = i === idx
        const row = `${on ? "❯" : " "} ${choices[i].label}`
        out.write(`\x1b[2K  ${on ? CYAN + row + RESET : row}\n`)
      }
    }
    render(true)
    readline.emitKeypressEvents(process.stdin)
    setRaw(true)
    process.stdin.resume()
    const cleanup = () => {
      process.stdin.off("keypress", onKey)
      setRaw(false)
      process.stdin.pause()
    }
    const onKey = (_s: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        idx = (idx - 1 + choices.length) % choices.length
        render(false)
      } else if (key.name === "down" || key.name === "j") {
        idx = (idx + 1) % choices.length
        render(false)
      } else if (key.name === "return" || key.name === "enter") {
        cleanup()
        resolve(choices[idx].value)
      } else if (key.ctrl && key.name === "c") {
        cleanup()
        out.write("\n")
        process.exit(130)
      }
    }
    process.stdin.on("keypress", onKey)
  })

// Arrow-key multi select: ↑/↓ to move, space to toggle, enter to confirm.
export const selectMany = (
  message: string,
  choices: { label: string; value: string; checked?: boolean }[],
): Promise<string[]> =>
  new Promise((resolve) => {
    const checked = choices.map((c) => !!c.checked)
    const collect = () => choices.filter((_, i) => checked[i]).map((c) => c.value)
    if (!isInteractive() || choices.length === 0) {
      resolve(collect())
      return
    }
    let idx = 0
    const out = process.stdout
    out.write(message + "\n")
    const render = (first: boolean) => {
      if (!first) out.write(`\x1b[${choices.length}A`)
      for (let i = 0; i < choices.length; i++) {
        const on = i === idx
        const row = `${on ? "❯" : " "} ${checked[i] ? "◉" : "◯"} ${choices[i].label}`
        out.write(`\x1b[2K  ${on ? CYAN + row + RESET : row}\n`)
      }
    }
    render(true)
    readline.emitKeypressEvents(process.stdin)
    setRaw(true)
    process.stdin.resume()
    const cleanup = () => {
      process.stdin.off("keypress", onKey)
      setRaw(false)
      process.stdin.pause()
    }
    const onKey = (s: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        idx = (idx - 1 + choices.length) % choices.length
        render(false)
      } else if (key.name === "down" || key.name === "j") {
        idx = (idx + 1) % choices.length
        render(false)
      } else if (key.name === "space" || s === " ") {
        checked[idx] = !checked[idx]
        render(false)
      } else if (key.name === "return" || key.name === "enter") {
        cleanup()
        resolve(collect())
      } else if (key.ctrl && key.name === "c") {
        cleanup()
        out.write("\n")
        process.exit(130)
      }
    }
    process.stdin.on("keypress", onKey)
  })
