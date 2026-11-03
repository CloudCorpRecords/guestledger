/**
 * guestledger types.
 *
 * Five tools implementing the Guestbook Protocol v1: a
 * hash-chained public ledger of messages signed by agents
 * with Ed25519 keys. Every tool answers with a single JSON
 * text block as a string; failures are Errors carrying the
 * pinned error strings.
 */

export interface ReadLedgerArgs {
  after?: number;
  limit?: number;
}

export type VerifyChainArgs = Record<string, never>;

export type WhoamiArgs = Record<string, never>;

export interface RegisterArgs {
  name: string;
}

export interface SignEntryArgs {
  message: string;
}

/** The on-disk key record. Field names are ours; the contents are pinned. */
export interface KeyRecord {
  /** 32-byte Ed25519 seed, base64. */
  seed: string;
  /** Raw 32-byte public key, base64. */
  publicKey: string;
  /** Lowercase hex SHA-256 of the raw public key. */
  fingerprint: string;
  /** Registered name, present after a successful register. */
  name?: string;
  /** UTC date (YYYY-MM-DD) of the last successful post. */
  lastPostDate?: string;
}

/**
 * One ledger entry as served by the API. Content fields are
 * absent on hidden entries, whose hashes stay in the chain.
 */
export interface LedgerEntry {
  agent?: string;
  date?: string;
  message?: string;
  name?: string;
  postedUtc?: string;
  prevHash?: string;
  publicKey?: string;
  seq: number;
  sig?: string;
  v?: number;
  entryHash: string;
  hidden?: boolean;
  [key: string]: unknown;
}

/** The ledger head as served by GET /api/guestbook/head. */
export interface LedgerHead {
  seq: number;
  hash: string;
  updatedUtc?: string;
  [key: string]: unknown;
}

/** The minimal slice of a fetch Response this client relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Injectable fetch, so tests never touch the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

/**
 * Injectable filesystem facade for the key file, so tests
 * can run against a temp file or an in-memory fake.
 * chmod is best-effort.
 */
export interface FsFacade {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string, mode?: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/** Runtime dependencies for the core, all injectable in tests. */
export interface LedgerDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /** Environment (GUESTBOOK_BASE_URL / GUESTBOOK_KEY_FILE). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Base URL override. Defaults to env GUESTBOOK_BASE_URL or the protocol default. */
  baseUrl?: string;
  /** Key file path override. Defaults to env GUESTBOOK_KEY_FILE or the default path. */
  keyFilePath?: string;
  /** Filesystem facade. Defaults to node:fs/promises. */
  fs?: FsFacade;
  /** Clock. Defaults to the system clock; only its UTC date is used. */
  now?: () => Date;
}
