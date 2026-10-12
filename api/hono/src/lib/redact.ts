import path from "node:path"

import {
  cacheDirFor,
  type Config,
  contractTilde,
  type NormalizedSkill,
  normalizeSkill,
  skillsCacheRoot,
  sourceLabel,
} from "inscope"

// Redaction runs before the diff, on the parsed .mcp.json, so a credential is caught by where it sits rather than by how its line happens to look.

const REDACTED = "<redacted>"

// words that name a credential on their own, and longer ones that do even inside a word ("dbpassword", "githubToken")
const CREDENTIAL_WORDS = new Set([
  "auth",
  "authorization",
  "connection",
  "cookie",
  "creds",
  "dsn",
  "jwt",
  "key",
  "pass",
  "pat",
  "pwd",
])
const CREDENTIAL_PARTS = [
  "apikey",
  "credential",
  "passphrase",
  "passwd",
  "password",
  "secret",
  "token",
]

// A key, flag, header, or variable whose name says it holds a credential, judged per word of the name (camelCase, snake_case, kebab-case), so `apiKey`, `DB_PASSWORD`, and `X-Api-Key` count while `keycloak`, `oauth`, and `clientId` do not.
export const isCredentialName = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .some(
      (word) => CREDENTIAL_WORDS.has(word) || CREDENTIAL_PARTS.some((part) => word.includes(part)),
    )

// only names an environment variable, with at most an empty default (`${SLACK_MCP_XOXP_TOKEN:-}`), or is a plain toggle, so it holds no secret
const NOT_SECRET = /^(\$\{\w+(:-)?\}|true|false|on|off|yes|no)$/i

// a value filled in at run time (`Bearer %s`, `${TOKEN}`, `$(gh auth token)`, the hook's `"$tok"`), or already withheld, is not a credential itself
const FILLED_LATER = /%s|\$\{|\$\(|<redacted>|^["']?\$\w+["']?$/

const holdsCredential = (name: string, value: string): boolean =>
  isCredentialName(name) && !FILLED_LATER.test(value)

// a token whose vendor prefix gives it away wherever it sits, a bare argument included: AWS, GitHub, GitLab, Google, Hugging Face, Linear, Notion, npm, OpenAI and Anthropic, Slack, Stripe
const VENDOR_TOKEN =
  /\b(?:A[KS]IA[0-9A-Z]{16}|gh[oprsu]_[A-Za-z0-9]{36}|github_pat_\w{22,}|glpat-[\w-]{20,}|AIza[\w-]{35}|hf_[A-Za-z0-9]{34,}|lin_api_[A-Za-z0-9]{32,}|(?:ntn|secret)_[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|sk-[\w-]{32,}|xox[abeprs]-[\w-]{10,}|[rs]k_(?:live|test)_[A-Za-z0-9]{24,})/g

// a shell default (`${API_KEY:-...}`) is the value the variable falls back to, so a credential-named one withholds it, while `${NAME}` and an empty `${NAME:-}` stay whole
const redactDefaults = (value: string): string =>
  value.replace(/\$\{(\w+):-([^}]+)\}/g, (whole: string, name: string) =>
    isCredentialName(name) ? `\${${name}:-${REDACTED}}` : whole,
  )

// where a value ends, by how it opens: a double-quoted one at its closing quote (escapes allowed), a single-quoted one at its own, a bare one at a quote; none crosses a line
const VALUE_END: Record<string, RegExp> = {
  '"': /^(?:[^"\\\r\n]|\\.)*/,
  "'": /^[^'\r\n]*/,
  "": /^[^\r\n"']*/,
}

const URL_START = String.raw`\b[a-z][a-z0-9+.-]*:\/\/`
const AUTH_SCHEMES = "Basic|Bearer|Token"

// a long opaque segment of a URL's path (24+ characters mixing letters and digits) is a token some hosted servers carry in the URL itself (https://mcp.zapier.com/api/mcp/s/<token>/mcp); a long versioned slug can be withheld with them
const OPAQUE_SEGMENT = /^(?=.*\d)(?=.*[A-Za-z])[\w-]{24,}$/

const redactUrlPath = (url: string): string =>
  url
    .split("/")
    .map((part, index) => (index > 2 && OPAQUE_SEGMENT.test(part) ? REDACTED : part))
    .join("/")

// A string that holds JSON (`--config '{"apiKey": "..."}'`) is redacted by structure like the file around it.
const redactJsonText = (value: string): string | null => {
  if (!/^\s*[[{]/.test(value)) return null
  try {
    return JSON.stringify(redactValue(JSON.parse(value)))
  } catch {
    return null
  }
}

// A `Name: value` header whose name says credential, withheld to the end of its line (`Cookie: a=x; b=y`) or, quoted, inside its quotes (`X-Api-Key: "..."`); each name on a line is judged, so an earlier, harmless one cannot hide it. A URL's user info (`https://x-access-token:...@host`) is left to the URL rules, which keep the host.
const redactHeaders = (value: string): string => {
  let out = ""
  let done = 0
  for (const match of value.matchAll(/\b([A-Za-z_][\w.-]*)\s*:(?!\/\/)\s*/g)) {
    // a URL's user info and a shell default's name are left to the rules for them
    const before = value.slice(0, match.index)
    if (match.index < done || before.endsWith("://") || before.endsWith("${")) continue
    const after = match.index + match[0].length
    const quote = value[after] === '"' || value[after] === "'" ? value[after] : ""
    const start = after + quote.length
    const inner = value.slice(start).match(VALUE_END[quote])?.[0] ?? ""
    if (!holdsCredential(match[1], inner)) continue
    out += `${value.slice(done, start)}${REDACTED}`
    done = start + inner.length
  }
  return out + value.slice(done)
}

// Every credential a free string can carry by its shape: the user info, query, fragment, and opaque path segments of a URL in any scheme (postgresql://user:pw@, wss://, ?token=, #access_token=, /s/<token>/), an HTTP auth scheme's token in any case, a token with a vendor prefix, a quoted JSON pair, a `name=value` (its value bare or quoted), and a `Name: value` header whose name says credential.
export const redactString = (value: string): string =>
  redactJsonText(value) ??
  redactHeaders(redactDefaults(value))
    .replace(new RegExp(`(${URL_START})[^\\s"'@/]*:[^\\s"']*@`, "gi"), `$1${REDACTED}@`)
    .replace(new RegExp(`(${URL_START})[^\\s"'@/:]*@`, "gi"), `$1${REDACTED}@`)
    .replace(new RegExp(`${URL_START}[^\\s"'?#]*`, "gi"), redactUrlPath)
    .replace(new RegExp(`(${URL_START}[^\\s?#"']*\\?)[^\\s#"']+`, "gi"), `$1${REDACTED}`)
    .replace(new RegExp(`(${URL_START}[^\\s#"']*#)[^\\s"']+`, "gi"), `$1${REDACTED}`)
    .replace(new RegExp(`\\b(${AUTH_SCHEMES})[ \\t]+[\\w.~+/=-]{8,}`, "gi"), `$1 ${REDACTED}`)
    .replace(VENDOR_TOKEN, REDACTED)
    .replace(
      /"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
      (pair: string, name: string, separator: string, inner: string) =>
        holdsCredential(name, inner) ? `"${name}"${separator}"${REDACTED}"` : pair,
    )
    .replace(
      /\b([A-Za-z_][\w.-]*)(\s*=\s*)("(?:[^"\\\r\n]|\\.)*"?|'[^'\r\n]*'?|[^\s,;&"']+)/g,
      (pair: string, name: string, separator: string, value: string) => {
        const quote = /^["']/.test(value) ? value[0] : ""
        const close = quote && value.length > 1 && value.endsWith(quote) ? quote : ""
        if (holdsCredential(name, value)) return `${name}${separator}${quote}${REDACTED}${close}`
        // a harmless name's quoted value can hold credentials of its own (`helper = "!f() { echo password=...; }; f"`), which this pattern has already stepped over
        const inner = value.slice(quote.length, value.length - close.length)
        return quote ? `${name}${separator}${quote}${redactString(inner)}${close}` : pair
      },
    )

const redactUnlessPlain = (value: unknown): unknown =>
  typeof value === "string" && NOT_SECRET.test(value) ? value : REDACTED

const redactAll = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactAll)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactAll(child)]))
  return redactUnlessPlain(value)
}

const ENV_FLAGS = new Set(["-e", "--env"])

// A command line: the value after a credential flag (`--api-key x`), and the value of a `KEY=value` passed to `-e`/`--env` (docker), whatever its name and in either `--env K=V` or `--env=K=V` form; every other argument goes through redactString.
const redactArgs = (args: unknown[]): unknown[] =>
  args.map((arg, index) => {
    const previous = args[index - 1]
    const flag = typeof previous === "string" && /^--?[\w-]+$/.test(previous) ? previous : ""
    if (flag && isCredentialName(flag)) return redactUnlessPlain(arg)
    if (typeof arg !== "string") return redactValue(arg)
    const variable = arg.match(/^([\w.-]+)=/)
    if (variable && ENV_FLAGS.has(flag)) return `${variable[0]}${REDACTED}`
    const inline = arg.match(/^(--?env=[\w.-]+=)/)
    if (inline) return `${inline[1]}${REDACTED}`
    return redactString(arg)
  })

// mcpServers' own keys are server names (`keycloak`, `auth0`), not settings, so the name rule starts one level below them
const redactServers = (servers: unknown): unknown =>
  servers !== null && typeof servers === "object" && !Array.isArray(servers)
    ? Object.fromEntries(
        Object.entries(servers).map(([name, server]) => [name, redactValue(server)]),
      )
    : redactValue(servers)

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return redactArgs(value)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "mcpServers"
        ? redactServers(child)
        : // every value under env or headers is a credential until it only names a variable or is a plain toggle
          key === "env" || key === "headers" || isCredentialName(key)
          ? redactAll(child)
          : redactValue(child),
    ]),
  )
}

// A .mcp.json's text with every credential replaced, re-serialized the way apply writes it; text that does not parse is withheld whole.
export const redactMcpText = (text: string): string => {
  if (!text) return text
  try {
    return `${JSON.stringify(redactValue(JSON.parse(text)), null, 2)}\n`
  } catch {
    return REDACTED
  }
}

// A skill's source as `inscope skill list` shows it, with a git URL's credentials withheld the way any URL's are.
export const skillSourceLabel = (skill: NormalizedSkill): string =>
  sourceLabel(
    skill.source.kind === "git"
      ? { ...skill, source: { ...skill.source, url: redactString(skill.source.url) } }
      : skill,
  )

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// A git skill's cache folder is named after its URL, credentials included (skills-cache/git/x-access-token-ghp_...-host-org-repo), so a path into one is shown only when the folder belongs to a skill the config declares from a URL that carries none; any other is withheld, since a link can outlive the skill that made it.
export const redactSkillPaths = (cfg: Config): ((text: string) => string) => {
  const gitCache = path.join(skillsCacheRoot(), "git")
  const shown = new Set(
    cfg.workspaces
      .flatMap((ws) => (ws.skills ?? []).map(normalizeSkill))
      .filter(
        (skill) => skill.source.kind === "git" && skillSourceLabel(skill) === sourceLabel(skill),
      )
      .map((skill) => path.basename(cacheDirFor(skill))),
  )
  const folder = new RegExp(
    `(${[gitCache, contractTilde(gitCache)].map(escapeRegExp).join("|")})/([^/\\s"']+)`,
    "g",
  )
  return (text) =>
    text.replace(folder, (match, root: string, name: string) =>
      shown.has(name) ? match : `${root}/${REDACTED}`,
    )
}
