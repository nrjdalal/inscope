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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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

// words that hold a credential word without naming one: a count of tokens, a tokenizer
const NOT_CREDENTIAL_WORDS = new Set(["tokenize", "tokenizer", "tokens"])

// a name ending in one of these says where something lives (`KEY_FILE`, `cookieFile`, `TOKEN_URL`), not what it is; a URL's own credentials are left to the URL rules
const LOCATION_WORDS = new Set(["dir", "file", "path", "url"])

// A key, flag, header, or variable whose name says it holds a credential, judged per word of the name (camelCase, snake_case, kebab-case), so `apiKey`, `DB_PASSWORD`, and `X-Api-Key` count while `keycloak`, `oauth`, `clientId`, `maxTokens`, and `KEY_FILE` do not.
export const isCredentialName = (name: string): boolean => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
  if (LOCATION_WORDS.has(words.at(-1) ?? "")) return false
  return words.some(
    (word) =>
      !NOT_CREDENTIAL_WORDS.has(word) &&
      (CREDENTIAL_WORDS.has(word) || CREDENTIAL_PARTS.some((part) => word.includes(part))),
  )
}

// the HTTP auth schemes whose token follows them (`Bearer ...`), read in any case
const AUTH_SCHEMES = "Basic|Bearer|Token"

// only names an environment variable, with at most an auth scheme before it (`Bearer ${API_KEY}`, Claude Code's own header form) and an empty default (`${SLACK_MCP_XOXP_TOKEN:-}`), or is a plain toggle, so it holds no secret
const NOT_SECRET = new RegExp(
  String.raw`^(((${AUTH_SCHEMES}) )?\$\{\w+(:-)?\}|true|false|on|off|yes|no)$`,
  "i",
)

// a value filled in at run time, or already withheld, is not a credential itself: a placeholder (`Bearer %s`, `${TOKEN}`, `$(gh auth token)`), a lone variable after at most an auth scheme (the hook's `"$tok"`, an escaped `\"$KEY\"`, `Bearer $MY_TOKEN`), or what a shell splice leaves inside a quoted pair, an auth scheme and the quote that ends the shell string (Claude Code's own `echo '{"Authorization": "Bearer '"$(get-token)"'"}'`)
const FILLED_LATER = [
  new RegExp(String.raw`\$\{|\$\(|${escapeRegExp(REDACTED)}`),
  // these match the whole value, after at most an auth scheme read in any case as the other rules read it, so a literal with `%s` inside (`p%sword`) is still a value; a lone variable counts in double quotes only, since single quotes keep a `$` literal (`'$ecret'`)
  new RegExp(
    [
      String.raw`^(\\?["'])?((${AUTH_SCHEMES}) )?%s(\\?["'])?$`,
      String.raw`^(\\?")?((${AUTH_SCHEMES}) )?\$\w+(\\?")?$`,
      String.raw`^(\\?["'])?((${AUTH_SCHEMES}) )?\\?["'](\\?["'])?$`,
    ].join("|"),
    "i",
  ),
]

// `quote` is the one a rule stepped over to reach the value, put back so a single-quoted `'$ecret'` reads as the literal it is
const holdsCredential = (name: string, value: string, quote = ""): boolean =>
  isCredentialName(name) && !FILLED_LATER.some((rule) => rule.test(`${quote}${value}${quote}`))

// a token whose vendor prefix gives it away wherever it sits, a bare argument included: AWS, GitHub, GitLab, Google, Hugging Face, Linear, Notion, npm, OpenAI and Anthropic, Slack, Stripe
const VENDOR_TOKEN =
  /\b(?:A[KS]IA[0-9A-Z]{16}|gh[oprsu]_[A-Za-z0-9]{36}|github_pat_\w{22,}|glpat-[\w-]{20,}|AIza[\w-]{35}|hf_[A-Za-z0-9]{34,}|lin_api_[A-Za-z0-9]{32,}|(?:ntn|secret)_[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|sk-[\w-]{32,}|xox[abeprs]-[\w-]{10,}|[rs]k_(?:live|test)_[A-Za-z0-9]{24,})/g

// a shell default (`${API_KEY:-...}`) is the value the variable falls back to, so a credential-named one withholds it, while `${NAME}` and an empty `${NAME:-}` stay whole
const redactDefaults = (value: string): string =>
  value.replace(/\$\{(\w+):-([^}]+)\}/g, (whole: string, name: string) =>
    isCredentialName(name) ? `\${${name}:-${REDACTED}}` : whole,
  )

// how a value can open, and what may lie inside before it closes: an escaped double quote inside an outer double-quoted string (`sh -c "... --api-key \"...\""`), a double quote (escapes allowed), or a single quote; none crosses a line
const QUOTES: Record<string, string> = {
  '\\"': String.raw`(?:[^"\\\r\n]|\\[^"\r\n])*`,
  '"': String.raw`(?:[^"\\\r\n]|\\.)*`,
  "'": String.raw`[^'\r\n]*`,
}

// a quoted value, its closing quote optional, so an unclosed one is withheld to its line's end
const QUOTED = Object.entries(QUOTES)
  .map(([quote, inside]) => `${escapeRegExp(quote)}${inside}(?:${escapeRegExp(quote)})?`)
  .join("|")

// a printf line escape (`\n`, `\r`, or `\\n` inside a git config string) starts the next line, and a tab (`\t`) the next field, so a bare value ends before one and a name begins after its letter (`username=me\npassword=...`)
const LINE_ESCAPE = String.raw`\\(?=\\*[nrt])`
const NAME_START = String.raw`(?:(?<=\\[nrt])|(?<!\\)\b)`

// a bare value, which runs through an escape (`p\$ss`) but stops at an escaped quote closing an outer one, at a line escape, or at any of `stops`
const bare = (stops = "") => String.raw`(?:[^\s${stops}"'\\]|(?!${LINE_ESCAPE})\\[^"'\s])+`

// the quote a value opens with at `at`, if it opens with one
const openingQuote = (text: string, at = 0): string =>
  Object.keys(QUOTES).find((q) => text.startsWith(q, at)) ?? ""

// a value as written: its opening quote, if any, the closing one, if it has one, and what lies between
const quoteParts = (raw: string) => {
  const quote = openingQuote(raw)
  const close = quote && raw.length > quote.length && raw.endsWith(quote) ? quote : ""
  return { close, inner: raw.slice(quote.length, raw.length - close.length), quote }
}

// a quoted value searched in turn for credentials of its own (`-c "npx server --api-key ..."`, `helper = "!f() { echo password=...; }; f"`), which a rule that takes the whole quote has stepped over; a bare value is returned as is
const searchedInside = (raw: string): string => {
  const { close, inner, quote } = quoteParts(raw)
  return quote ? `${quote}${redactString(inner)}${close}` : raw
}

// a value withheld, its quotes kept
const withheld = (raw: string): string => {
  const { close, quote } = quoteParts(raw)
  return `${quote}${REDACTED}${close}`
}

// a value as a rule shows it: withheld when its name says credential, otherwise searched inside if quoted
const shownValue = (name: string, raw: string): string =>
  holdsCredential(name, raw) ? withheld(raw) : searchedInside(raw)

// where a header's value ends, by how it opens: a quoted one at its closing quote, a bare one at a quote, escaped or not, or at a line escape; none crosses a line
const VALUE_END: Record<string, RegExp> = {
  ...Object.fromEntries(
    Object.entries(QUOTES).map(([quote, inside]) => [quote, new RegExp(`^${inside}`)]),
  ),
  "": new RegExp(String.raw`^(?:[^\r\n"'\\]|(?!${LINE_ESCAPE})\\[^"'\r\n])*`),
}

const URL_START = String.raw`\b[a-z][a-z0-9+.-]*:\/\/`

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

// a header's name and colon, never a URL's scheme (`https://`)
const HEADER_NAME = new RegExp(String.raw`${NAME_START}([A-Za-z_][\w.-]*)\s*:(?!\/\/)\s*`, "g")

// A `Name: value` header whose name says credential, withheld to the end of its line (`Cookie: a=x; b=y`) or, quoted, inside its quotes (`X-Api-Key: "..."`); each name on a line is judged, so an earlier, harmless one cannot hide it. A URL's user info (`https://x-access-token:...@host`) is left to the URL rules, which keep the host.
const redactHeaders = (value: string): string => {
  let out = ""
  let done = 0
  for (const match of value.matchAll(HEADER_NAME)) {
    // a URL's user info and a shell default's name are left to the rules for them
    const before = value.slice(0, match.index)
    if (match.index < done || before.endsWith("://") || before.endsWith("${")) continue
    const after = match.index + match[0].length
    const quote = openingQuote(value, after)
    const start = after + quote.length
    const inner = value.slice(start).match(VALUE_END[quote])?.[0] ?? ""
    if (!holdsCredential(match[1], inner, quote)) continue
    out += `${value.slice(done, start)}${REDACTED}`
    done = start + inner.length
  }
  return out + value.slice(done)
}

// user info with no scheme in front (`oauth2:<token>@gitlab.com/org/repo`), as a git remote or a skill source can carry it, withheld before the header rule could read `name:` as a header and take the host with it; a scheme's own user info is left to the URL rules
const redactBareUserInfo = (value: string): string =>
  value.replace(
    /(^|[\s"'=(,])[\w.~%+-]+:[^\s"'@/]+@(?=[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g,
    `$1${REDACTED}@`,
  )

// a quoted `"name": "value"` pair whose name says credential, its quotes plain, escaped inside an outer double-quoted string (`echo "{\"X-Api-Key\": \"...\"}"`), or single
const PAIRS = Object.entries(QUOTES).map(([quote, inside]) => {
  const q = escapeRegExp(quote)
  return {
    pattern: new RegExp(String.raw`${q}([^"'\\]+)${q}(\s*:\s*)${q}(${inside})${q}`, "g"),
    quote,
  }
})

const redactPairs = (value: string): string =>
  PAIRS.reduce(
    (text, { pattern, quote }) =>
      text.replace(pattern, (pair: string, name: string, separator: string, inner: string) =>
        holdsCredential(name, inner, quote)
          ? `${quote}${name}${quote}${separator}${quote}${REDACTED}${quote}`
          : pair,
      ),
    value,
  )

// Every credential a free string can carry by its shape: the user info, query, fragment, and opaque path segments of a URL in any scheme (postgresql://user:pw@, wss://, ?token=, #access_token=, /s/<token>/), user info with no scheme (oauth2:<token>@gitlab.com/...), an HTTP auth scheme's token in any case, a token with a vendor prefix, a quoted JSON pair, a credential flag's value (`--api-key <key>`), a `name=value` (its value bare or quoted), and a `Name: value` header whose name says credential.
export const redactString = (value: string): string =>
  redactJsonText(value) ??
  redactPairs(
    redactHeaders(redactBareUserInfo(redactDefaults(value)))
      .replace(new RegExp(`(${URL_START})[^\\s"'@/]*:[^\\s"']*@`, "gi"), `$1${REDACTED}@`)
      .replace(new RegExp(`(${URL_START})[^\\s"'@/:]*@`, "gi"), `$1${REDACTED}@`)
      .replace(new RegExp(`${URL_START}[^\\s"'?#]*`, "gi"), redactUrlPath)
      .replace(new RegExp(`(${URL_START}[^\\s?#"']*\\?)[^\\s#"']+`, "gi"), `$1${REDACTED}`)
      .replace(new RegExp(`(${URL_START}[^\\s#"']*#)[^\\s"']+`, "gi"), `$1${REDACTED}`)
      // never a following flag, which would take its name and leave its value (`@acme/token --api-key ...`)
      .replace(
        new RegExp(`\\b(${AUTH_SCHEMES})[ \\t]+(?!-)[\\w.~+/=-]{8,}`, "gi"),
        `$1 ${REDACTED}`,
      )
      .replace(VENDOR_TOKEN, REDACTED)
      .replace(
        // a flag can open a nested, escaped quote (`-c "echo \"--api-key ...\""`), so it may follow a quote as well as a space
        new RegExp(
          String.raw`(^|[\s"'])(--?[A-Za-z][\w-]*)([ \t]+)(?!-)(${QUOTED}|${bare()})`,
          "g",
        ),
        (_: string, lead: string, flag: string, space: string, raw: string) =>
          `${lead}${flag}${space}${shownValue(flag, raw)}`,
      ),
  ).replace(
    new RegExp(String.raw`${NAME_START}([A-Za-z_][\w.-]*)(\s*=\s*)(${QUOTED}|${bare(",;&")})`, "g"),
    (_: string, name: string, separator: string, raw: string) =>
      `${name}${separator}${shownValue(name, raw)}`,
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

// A command line: the value after a credential flag (`--api-key x`; an argument starting with `-` is the next flag, as in one string), and the value of a `KEY=value` passed to `-e`/`--env` (docker), whatever its name and in either `--env K=V` or `--env=K=V` form; every other argument goes through redactString.
const redactArgs = (args: unknown[]): unknown[] =>
  args.map((arg, index) => {
    const previous = args[index - 1]
    const flag = typeof previous === "string" && /^--?[\w-]+$/.test(previous) ? previous : ""
    const nextFlag = typeof arg === "string" && arg.startsWith("-")
    if (flag && isCredentialName(flag) && !nextFlag) return redactUnlessPlain(arg)
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
