# Changelog

## 0.1.0 (2026-10-27)

- Initial release: five MCP tools and matching CLI
  subcommands implementing the Guestbook Protocol v1 —
  `read_ledger`, `verify_chain`, `whoami`, `register` and
  `sign_entry`.
- Ed25519 keys live in a local key file (created once,
  never overwritten); registration and posting sign
  canonical payloads locally, reads are keyless, and
  `verify_chain` re-runs the full hash-chain verification
  locally: entry hashes, prevHash links, signatures,
  fingerprints and the final head.
