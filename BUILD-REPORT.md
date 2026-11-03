# guestledger — Build Report (Batch 24)

Rebuild of the `com.bluecloudcyber/guestbook` MCP server
(npm `@bluecloudcyberai/guestbook-mcp` v0.1.0) from the
firsthand spec in `specs-batch24/guestledger.md` and the
Guestbook Protocol v1 document saved as
`specs-batch24/guestbook-agents.txt`. Built 2026-10-27.

## Identity

- npm: `@reneturcios/guestledger` @ 0.1.0, bin
  `guestledger` → `dist/cli.js`
- MCP Registry name: `io.github.CloudCorpRecords/guestledger`
  (matches `package.json` `mcpName`, `server.json` `name`,
  and the Dockerfile `io.modelcontextprotocol.server.name`
  label)
- server.json description (89 chars, verified):
  "Signed agent guestbook: Ed25519 keys, one chained entry
  per day, full chain verification."
- server.json: npm package entry carries `"version":
  "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/guestledger:0.1.0`) carries
  **no** `version` field (verified).

## Files (factory set, per TEMPLATE.md §2 plus .dockerignore)

package.json, server.json, Dockerfile, tsconfig.json
(byte-identical to builds/casebrief/tsconfig.json, verified
with `cmp`), .gitignore, .dockerignore, package-lock.json,
README.md (fresh prose), LICENSE (MIT, © 2026 Rene
Turcios), CHANGELOG.md (single 0.1.0 entry dated
2026-10-27), src/index.ts, src/cli.ts, src/mcp.ts,
src/types.ts, src/ledger.ts (core), test/ledger.test.ts,
and the four workflows under .github/workflows/
(publish-container adapted: IMAGE
ghcr.io/cloudcorprecords/guestledger, smoke assertion on
server name `guestledger`). Plus this BUILD-REPORT.md and
the parity-out/ artifacts. The parity fixture lives at
`harness/fixtures/guestbook-tools-original.json` with the
spec's exact `_source` string.

## Implementation

- `src/mcp.ts`: low-level `Server` API
  (`sdk/server/index.js` + `StdioServerTransport`, handlers
  for `ListToolsRequestSchema` / `CallToolRequestSchema`
  from `sdk/types.js`), explicit JSON-schema literals for
  all five tools (read_ledger, verify_chain, whoami,
  register, sign_entry); no McpServer/zod registration.
  Tool descriptions and input schemas are the fixture's,
  exactly.
- `src/ledger.ts`: `VERSION = "0.1.0"`. All external
  access goes through injectable deps (`fetchFn`, `env`,
  `baseUrl`, `keyFilePath`, an fs facade, and a `now()`
  clock), so tests are fully offline. Ed25519 via
  `node:crypto`: a 32-byte seed is imported with the
  PKCS8 prefix `302e020100300506032b657004220420`, the raw
  public key is the last 32 bytes of the SPKI export, and
  raw keys are verified with the SPKI header
  `302a300506032b6570032100`. Fingerprint = lowercase hex
  SHA-256 of the raw public key. Canonical payloads keep
  the pinned key order; the entry hash is the SHA-256 of
  the alphabetical-key JSON form with `v: 1` included.
- Key file: `~/.config/bluecloud-guestbook/key.json`
  (overridable via `GUESTBOOK_KEY_FILE`), holding
  `{seed, publicKey, fingerprint, name?, lastPostDate?}`
  with seed/publicKey base64. Directory mode 0700, file
  mode 0600 (chmod best-effort). A key is created once and
  never overwritten: `register` reuses an existing key,
  persists the name only after a successful registration,
  and `sign_entry` persists `lastPostDate` only after a
  successful post and returns both upstream bodies
  verbatim.
- Base URL: `GUESTBOOK_BASE_URL`, default
  `https://agents.bluecloudcyber.com`; a non-https base
  outside localhost fails every network tool with
  `GUESTBOOK_BASE_URL must use https except for localhost`
  before any request. `whoami` makes no network request.
- Local validation runs before any request with the
  spec's strings: the name rule
  (`name must be 3 to 32 characters from A-Z a-z 0-9 space
  _ . -`), the message rules (`message must be 1 to 280
  characters` by Unicode code points; `message must be a
  single line of plain text` rejecting
  U+0000–U+001F, U+007F–U+009F, U+200B–U+200F,
  U+202A–U+202E, U+2060–U+2064, U+2066–U+206F and
  U+FEFF; `message must not contain angle brackets or
  URLs`, where URL detection rejects `://`, `www.`, or a
  bare domain ending in a common TLD),
  `no guestbook key on this machine — call register
  first`, and `this key is not registered yet — call
  register first`.
- Upstream errors follow the pinned mapping: a body that
  parses as `{error:{code,message}}` → `guestbook error:
  <code>: <message>`; any other non-2xx → `guestbook
  error: HTTP <status>`; a throwing fetch → `guestbook
  unreachable`.
- `verify_chain` paginates with limit 500 until a short
  page, then per entry in seq order: prevHash link first
  (the first entry's prevHash is 64 zeros), then — unless
  the entry is hidden/content-withheld, in which case only
  the chain position is checked — entry hash, Ed25519
  signature over the canonical post payload, and
  fingerprint. Finally the last entryHash and seq are
  checked against the head. Returns `{valid, checked,
  head_seq}` or `{valid: false, checked, failure: {seq,
  reason}}`; an empty ledger is valid when head.seq is 0.
  `checked` counts entries that passed before a failure.
- CLI: one subcommand per tool taking a JSON argument
  string, `mcp`, `--version` (prints `0.1.0`); unknown
  subcommand → usage on stderr, exit 2; tool failures
  exit 1.

## Endpoint provenance (pinned vs ours)

Pinned by agents.txt / the README, via the spec:

- The five tools and their arguments; the key-file
  behaviour, server URL and env vars; the fingerprint
  definition; both canonical payload shapes and key
  order; the endpoint paths `POST /api/guestbook/agents`,
  `POST /api/guestbook/entries`,
  `GET /api/guestbook/entries?after=<seq>&limit=<n>` and
  `GET /api/guestbook/head`; the entry-hash construction;
  the name/message rules and caps; and the
  `{error:{code,message}}` vocabulary.

Ours (labelled in the spec): the key-file JSON field
names; the `read_ledger` result composition
`{entries, head}` and its default limit 50; the
`verify_chain` / `whoami` result renderings and failure
reason strings; the local validation strings; and the
bare-domain TLD heuristic for "no URLs".

## Verification (all real, run 2026-10-27)

- `npm run build` (tsc): exit 0. Fresh `npx tsc --noEmit`:
  exit 0.
- `npm test`: **56 tests, 56 pass, 0 fail** — fake fetch,
  temp key files and an injected clock only, no live
  network (the CLI tests spawn the CLI through tsx and
  exercise only paths that fail before any request, plus
  `whoami`, which never touches the network). Covers:
  the three agents.txt vectors asserted exactly (seed →
  public key `Tqu34PU3voA3cliHj0hQPb6QzY6HlkaFbATOdkNYCFc=`
  and fingerprint `5aebeaffeacd...`; the register
  signature; the post signature; the full entry hash
  `52af3894750d99a203cf800f9eb76e1fed37ac8d7bccb63aa9ab1e403b9c0f9c`);
  name/message validation incl. code-point counting,
  zero-width/bidi rejection and the three URL forms;
  whoami in all key states; register creating a key (file
  mode 0600, directory 0700, signature verified over the
  canonical payload), reusing the vector key and
  reproducing the pinned register signature verbatim, and
  persisting the name only on success; sign_entry
  reproducing the pinned post signature for the vector
  message under the fixed clock, persisting lastPostDate,
  and the no-key / unregistered strings; read_ledger URL
  composition (after only when given, default limit 50),
  paging, argument rejection and the http-localhost
  allowance; verify_chain end-to-end on a synthetic signed
  chain — valid chain, empty ledger, tampered message,
  rehashed prevHash break, rehashed bad signature,
  re-signed fingerprint swap, a hidden middle entry, head
  hash/seq mismatches, and 501-entry pagination in two
  limit-500 pages; the structured / HTTP / unreachable
  error mappings; and the CLI cases (`--version` exit 0,
  unknown subcommand / non-JSON argument / extra arguments
  exit 2, no-key and invalid-name exit 1).
- `node dist/cli.js --version`: prints `0.1.0`. Unknown
  subcommand exits 2 with usage.
- Parity: tools captured from the built server
  (initialize + tools/list over stdio into
  `parity-out/tools-rebuild.json`), then
  `harness/parity.py` against
  `harness/fixtures/guestbook-tools-original.json` →
  **PASS, parity 100.0, identical_tools 5 / total 5**
  (see `parity-out/parity.json`).
- Lockfile (Route 3, clean from birth): generated in a
  temp dir containing only `package.json` with
  `npm install --package-lock-only --ignore-scripts
  --offline`; verified it parses, `name` ==
  `@reneturcios/guestledger`, **128 package entries**;
  copied in as `package-lock.json`, then
  `npm install --offline` in the build dir succeeded.
- Version consistency: `package.json` 0.1.0 =
  `server.json` top-level 0.1.0 = npm entry 0.1.0 = OCI
  tag `:0.1.0` = core `VERSION` 0.1.0 = CHANGELOG heading
  `## 0.1.0 (2026-10-27)`.

## Gaps

- Live upstream behaviour is unproven: no live call was
  made (tests are fake-fetch only). In particular the
  exact JSON shape of the upstream entries list (array vs
  envelope) and the hidden-entry flag are handled
  defensively in the core — an array or an `{entries}`
  envelope are both accepted, and an entry counts as
  hidden when `hidden` is set or its content fields are
  absent — but only the protocol-pinned parts (paths,
  head shape, entry fields, hash chain) are asserted.
- The bare-domain TLD list used for the message rule's
  "no URLs" check is a heuristic rendering of the
  protocol's rule, as labelled in the spec; an exotic TLD
  outside the list would pass locally and be left to the
  server's own rejection.
