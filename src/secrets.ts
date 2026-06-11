import { spawnSync } from "node:child_process"

export type RunResult = { status: number; stdout: string; stderr: string }

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { input?: string },
) => RunResult

export const defaultRunner: Runner = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, { encoding: "utf8", input: opts?.input })
  return {
    status: res.status ?? (res.error ? 127 : 1),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  }
}

export const isMacOS = () => process.platform === "darwin"

const user = () => process.env.USER || ""

export const ghToken = (account: string, run: Runner = defaultRunner) => {
  const r = run("gh", ["auth", "token", "-u", account])
  const tok = r.stdout.trim()
  return r.status === 0 && tok ? tok : null
}

export const ghStatus = (run: Runner = defaultRunner) => {
  const r = run("gh", ["auth", "status"])
  return (r.stdout + r.stderr).trim()
}

// Unique gh accounts parsed from `gh auth status`, in the order they appear.
export const ghAccounts = (run: Runner = defaultRunner): string[] => {
  const names: string[] = []
  for (const m of ghStatus(run).matchAll(/account (\S+) \(/g)) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

export const gitGlobal = (
  key: string,
  run: Runner = defaultRunner,
): string | null => {
  const r = run("git", ["config", "--global", key])
  const v = r.stdout.trim()
  return r.status === 0 && v ? v : null
}

export const keychainHas = (service: string, run: Runner = defaultRunner) => {
  const r = run("security", [
    "find-generic-password",
    "-a",
    user(),
    "-s",
    service,
    "-w",
  ])
  return r.status === 0 && r.stdout.trim().length > 0
}

export const keychainSet = (
  service: string,
  token: string,
  run: Runner = defaultRunner,
) => {
  const r = run("security", [
    "add-generic-password",
    "-U",
    "-a",
    user(),
    "-s",
    service,
    "-w",
    token,
  ])
  if (r.status !== 0) {
    throw new Error(
      `security add-generic-password failed: ${r.stderr.trim() || "unknown error"}`,
    )
  }
}

export const keychainSetCommand = (service: string) =>
  `security add-generic-password -U -a "${user() || "$USER"}" -s ${service} -w 'xoxp-...'`

export const gitEmailForFile = (file: string, run: Runner = defaultRunner) => {
  const r = run("git", ["config", "--file", file, "user.email"])
  return r.status === 0 ? r.stdout.trim() : null
}
