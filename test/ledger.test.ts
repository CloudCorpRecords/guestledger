import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPostPayload,
  canonicalRegisterPayload,
  computeEntryHash,
  deriveKeyFromSeed,
  generateKey,
  loadKey,
  readLedger,
  registerAgent,
  saveKey,
  signEntry,
  signPayload,
  validateMessage,
  validateName,
  verifyChain,
  verifyPayload,
  whoami,
  ZERO_HASH,
} from "../src/ledger.js";
import type { FetchFn, KeyRecord, LedgerDeps, LedgerEntry } from "../src/types.js";

/**
 * Every test runs against an injected fake fetch, a temp
 * key file and an injected clock: no live network, no live
 * call is made. The agents.txt test vectors are asserted
 * exactly. The CLI tests spawn the real CLI through tsx and
 * only exercise paths that fail before any request, plus
 * whoami against a temp key file (no network by design).
 */

/* ------------------------------------------------------------------ */
/* Test vectors from agents.txt                                        */
/* ------------------------------------------------------------------ */

const SEED_B64 = "8TYFKvc3XDjB/A5CfOGwft/u4PTKxg0gCvNZjWx5JqY=";
const PUB_B64 = "Tqu34PU3voA3cliHj0hQPb6QzY6HlkaFbATOdkNYCFc=";
const FINGERPRINT = "5aebeaffeacd1d5f1fe865907b32666a0777b54fd537d6dcb67e5e4d3a265624";
const REGISTER_SIG =
  "wwiQHgENWvpO8iPgs8QJIAYdTfXxaIRIeCPntTCa/g5qhioSjjO/tStZYkHxh23FFRIUah8SpggB70X8tNAoDA==";
const POST_MESSAGE = "A worked example, straight from the spec.";
const POST_SIG =
  "4Q2SXndC0MojXRfJP8/kpt6btSls3BUVXUoj3mr8qiUZswmNsO5tYLLtuHMcEf/Ua5/CRHHux0sfAEjX6xIQAg==";
const ENTRY_HASH = "52af3894750d99a203cf800f9eb76e1fed37ac8d7bccb63aa9ab1e403b9c0f9c";

const vectorKey = deriveKeyFromSeed(Buffer.from(SEED_B64, "base64"));

const FIXED_NOW = () => new Date("2026-09-07T12:00:00.000Z");

describe("agents.txt test vectors", () => {
  it("derives the pinned public key and fingerprint from the seed", () => {
    assert.equal(vectorKey.publicKey, PUB_B64);
    assert.equal(vectorKey.fingerprint, FINGERPRINT);
    assert.equal(vectorKey.seed, SEED_B64);
  });

  it("signs the canonical register payload to the pinned signature", () => {
    const payload = canonicalRegisterPayload("Example Agent", PUB_B64);
    assert.equal(
      payload,
      '{"action":"register","name":"Example Agent","publicKey":"Tqu34PU3voA3cliHj0hQPb6QzY6HlkaFbATOdkNYCFc=","v":1}',
    );
    assert.equal(signPayload(vectorKey.privateKey, payload), REGISTER_SIG);
  });

  it("signs the canonical post payload to the pinned signature", () => {
    const payload = canonicalPostPayload(FINGERPRINT, "2026-09-07", POST_MESSAGE);
    assert.equal(
      payload,
      '{"action":"post","agent":"5aebeaffeacd1d5f1fe865907b32666a0777b54fd537d6dcb67e5e4d3a265624","date":"2026-09-07","message":"A worked example, straight from the spec.","v":1}',
    );
    assert.equal(signPayload(vectorKey.privateKey, payload), POST_SIG);
  });

  it("hashes the full pinned entry to 52af3894...", () => {
    const entry: LedgerEntry = {
      agent: FINGERPRINT,
      date: "2026-09-07",
      message: POST_MESSAGE,
      name: "Example Agent",
      postedUtc: "2026-09-07T12:00:00.000Z",
      prevHash: ZERO_HASH,
      publicKey: PUB_B64,
      seq: 1,
      sig: POST_SIG,
      v: 1,
      entryHash: "",
    };
    assert.equal(computeEntryHash(entry), ENTRY_HASH);
  });

  it("verifies the pinned signatures and rejects a tampered payload", () => {
    const pubRaw = Buffer.from(PUB_B64, "base64");
    assert.equal(
      verifyPayload(pubRaw, canonicalRegisterPayload("Example Agent", PUB_B64), REGISTER_SIG),
      true,
    );
    assert.equal(
      verifyPayload(pubRaw, canonicalPostPayload(FINGERPRINT, "2026-09-07", POST_MESSAGE), POST_SIG),
      true,
    );
    assert.equal(
      verifyPayload(pubRaw, canonicalPostPayload(FINGERPRINT, "2026-09-08", POST_MESSAGE), POST_SIG),
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Fake fetch + deps helpers                                           */
/* ------------------------------------------------------------------ */

type Captured = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

interface FakeState {
  entries: LedgerEntry[];
  head: { seq: number; hash: string; updatedUtc: string };
  registerStatus?: number;
  registerBody?: unknown;
  postStatus?: number;
  postBody?: unknown;
  getStatus?: number;
  getBody?: unknown;
}

function makeFetch(state: FakeState, captured: Captured[] = []): FetchFn {
  return async (url, init) => {
    captured.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const u = new URL(url);
    const respond = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });
    if (u.pathname === "/api/guestbook/agents" && init?.method === "POST") {
      const req = JSON.parse(init.body ?? "{}") as { name: string; publicKey: string };
      const { createHash } = await import("node:crypto");
      const agent = createHash("sha256")
        .update(Buffer.from(req.publicKey, "base64"))
        .digest("hex");
      return respond(state.registerStatus ?? 201, state.registerBody ?? { agent, name: req.name });
    }
    if (u.pathname === "/api/guestbook/entries" && init?.method === "POST") {
      return respond(
        state.postStatus ?? 201,
        state.postBody ?? {
          seq: 7,
          prevHash: ZERO_HASH,
          entryHash: "ab".repeat(32),
          postedUtc: "2026-09-07T12:00:00.000Z",
        },
      );
    }
    if (u.pathname === "/api/guestbook/entries") {
      if (state.getStatus !== undefined) return respond(state.getStatus, state.getBody ?? "");
      const after = u.searchParams.has("after") ? Number(u.searchParams.get("after")) : 0;
      const limit = u.searchParams.has("limit") ? Number(u.searchParams.get("limit")) : 50;
      return respond(200, state.entries.filter((e) => e.seq > after).slice(0, limit));
    }
    if (u.pathname === "/api/guestbook/head") {
      if (state.getStatus !== undefined) return respond(state.getStatus, state.getBody ?? "");
      return respond(200, state.head);
    }
    return respond(404, { error: { code: "invalid-request", message: "no such route" } });
  };
}

const throwingFetch: FetchFn = async () => {
  throw new Error("connection refused");
};

async function tempKeyFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "guestledger-test-"));
  return join(dir, "key.json");
}

function deps(
  fetchFn: FetchFn,
  keyFilePath: string,
  extra: Partial<LedgerDeps> = {},
): LedgerDeps {
  return { fetchFn, env: {}, keyFilePath, now: FIXED_NOW, ...extra };
}

async function expectError(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal(err instanceof Error ? err.message : String(err), message);
    return true;
  });
}

const HEAD0 = { seq: 0, hash: ZERO_HASH, updatedUtc: "2026-09-07T00:00:00.000Z" };

const VECTOR_RECORD: KeyRecord = {
  seed: SEED_B64,
  publicKey: PUB_B64,
  fingerprint: FINGERPRINT,
};

/* ------------------------------------------------------------------ */
/* Local validation                                                    */
/* ------------------------------------------------------------------ */

describe("validateName", () => {
  it("accepts names at the 3 and 32 character bounds and the full alphabet", () => {
    assert.equal(validateName("Abc"), "Abc");
    assert.equal(validateName("A".repeat(32)), "A".repeat(32));
    assert.equal(validateName("Agent One_2.0-x"), "Agent One_2.0-x");
  });

  it("rejects names below 3 or above 32 characters", () => {
    assert.throws(() => validateName("Ab"), /name must be 3 to 32 characters/);
    assert.throws(() => validateName("A".repeat(33)), /name must be 3 to 32 characters/);
    assert.throws(() => validateName(""), /name must be 3 to 32 characters/);
  });

  it("rejects characters outside the allowed set", () => {
    assert.throws(() => validateName("Bad!Name"), /name must be 3 to 32 characters/);
    assert.throws(() => validateName("name@host"), /name must be 3 to 32 characters/);
    assert.throws(() => validateName("René"), /name must be 3 to 32 characters/);
  });

  it("rejects a missing or non-string name", () => {
    assert.throws(() => validateName(undefined), /name must be 3 to 32 characters/);
    assert.throws(() => validateName(42), /name must be 3 to 32 characters/);
  });
});

describe("validateMessage", () => {
  it("accepts plain messages at the 1 and 280 code point bounds", () => {
    assert.equal(validateMessage("x"), "x");
    assert.equal(validateMessage("a".repeat(280)), "a".repeat(280));
    assert.equal(validateMessage("Fixed the bug. Shipped it today, all good."), "Fixed the bug. Shipped it today, all good.");
  });

  it("rejects empty and over-280 messages with the length string", () => {
    assert.throws(() => validateMessage(""), /message must be 1 to 280 characters/);
    assert.throws(() => validateMessage("a".repeat(281)), /message must be 1 to 280 characters/);
    assert.throws(() => validateMessage(undefined), /message must be 1 to 280 characters/);
  });

  it("rejects newlines, control, zero-width and bidi characters as not plain text", () => {
    assert.throws(() => validateMessage("two\nlines"), /message must be a single line of plain text/);
    assert.throws(() => validateMessage("tab\there"), /message must be a single line of plain text/);
    assert.throws(() => validateMessage("zero​width"), /message must be a single line of plain text/);
    assert.throws(() => validateMessage("bidi ‮ control"), /message must be a single line of plain text/);
  });

  it("rejects angle brackets", () => {
    assert.throws(() => validateMessage("a < b"), /message must not contain angle brackets or URLs/);
    assert.throws(() => validateMessage("<script>"), /message must not contain angle brackets or URLs/);
  });

  it("rejects URLs: scheme, www. and bare domains", () => {
    assert.throws(() => validateMessage("see https://example.com/x"), /message must not contain angle brackets or URLs/);
    assert.throws(() => validateMessage("visit www.example.com today"), /message must not contain angle brackets or URLs/);
    assert.throws(() => validateMessage("it is on example.com now"), /message must not contain angle brackets or URLs/);
    assert.throws(() => validateMessage("go to sub.domain.io please"), /message must not contain angle brackets or URLs/);
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    const msg = "🎉".repeat(280);
    assert.equal(validateMessage(msg), msg);
    assert.throws(() => validateMessage("🎉".repeat(281)), /message must be 1 to 280 characters/);
  });
});

/* ------------------------------------------------------------------ */
/* whoami                                                              */
/* ------------------------------------------------------------------ */

describe("whoami", () => {
  it("reports no key and makes no network request", async () => {
    const captured: Captured[] = [];
    const out = await whoami({}, deps(makeFetch({ entries: [], head: HEAD0 }, captured), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), { has_key: false, registered: false, posted_today: false });
    assert.deepEqual(captured, []);
  });

  it("reports fingerprint, name, registration and posted-today for a registered key", async () => {
    const keyFile = await tempKeyFile();
    const d = deps(throwingFetch, keyFile);
    await saveKey({ ...VECTOR_RECORD, name: "Example Agent", lastPostDate: "2026-09-07" }, d);
    const out = await whoami({}, d);
    assert.deepEqual(JSON.parse(out), {
      has_key: true,
      fingerprint: FINGERPRINT,
      name: "Example Agent",
      registered: true,
      posted_today: true,
    });
  });

  it("reports posted_today false when the last post was another day, and registered false without a name", async () => {
    const keyFile = await tempKeyFile();
    const d = deps(throwingFetch, keyFile);
    await saveKey({ ...VECTOR_RECORD, name: "Example Agent", lastPostDate: "2026-09-06" }, d);
    const parsed = JSON.parse(await whoami({}, d)) as Record<string, unknown>;
    assert.equal(parsed.posted_today, false);
    assert.equal(parsed.registered, true);
    await saveKey({ ...VECTOR_RECORD }, d);
    const bare = JSON.parse(await whoami({}, d)) as Record<string, unknown>;
    assert.equal(bare.has_key, true);
    assert.equal(bare.registered, false);
    assert.equal("name" in bare, false);
  });
});

/* ------------------------------------------------------------------ */
/* register                                                            */
/* ------------------------------------------------------------------ */

describe("register", () => {
  it("creates a key, posts a verifiable signed body, persists the name, returns the body verbatim", async () => {
    const captured: Captured[] = [];
    const keyFile = await tempKeyFile();
    const d = deps(makeFetch({ entries: [], head: HEAD0 }, captured), keyFile);
    const out = await registerAgent({ name: "New Agent" }, d);
    const parsed = JSON.parse(out) as { agent: string; name: string };
    assert.equal(parsed.name, "New Agent");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://agents.bluecloudcyber.com/api/guestbook/agents");
    assert.equal(captured[0].method, "POST");
    const body = JSON.parse(captured[0].body ?? "") as {
      name: string;
      publicKey: string;
      signature: string;
    };
    assert.equal(body.name, "New Agent");
    // The returned agent is the fingerprint of the sent public key.
    const { createHash } = await import("node:crypto");
    assert.equal(
      parsed.agent,
      createHash("sha256").update(Buffer.from(body.publicKey, "base64")).digest("hex"),
    );
    // The signature verifies over the canonical payload against the sent key.
    assert.equal(
      verifyPayload(
        Buffer.from(body.publicKey, "base64"),
        canonicalRegisterPayload("New Agent", body.publicKey),
        body.signature,
      ),
      true,
    );
    // Key file persisted with the name, mode 0600, directory mode 0700.
    const saved = await loadKey(d);
    assert.equal(saved?.name, "New Agent");
    assert.equal(saved?.publicKey, body.publicKey);
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(keyFile))).mode & 0o777, 0o700);
  });

  it("reuses an existing key and reproduces the pinned register signature", async () => {
    const captured: Captured[] = [];
    const keyFile = await tempKeyFile();
    const d = deps(makeFetch({ entries: [], head: HEAD0 }, captured), keyFile);
    await saveKey({ ...VECTOR_RECORD }, d);
    const out = await registerAgent({ name: "Example Agent" }, d);
    assert.deepEqual(JSON.parse(out), { agent: FINGERPRINT, name: "Example Agent" });
    const body = JSON.parse(captured[0].body ?? "") as {
      name: string;
      publicKey: string;
      signature: string;
    };
    assert.equal(body.publicKey, PUB_B64);
    assert.equal(body.signature, REGISTER_SIG);
    const saved = await loadKey(d);
    assert.equal(saved?.seed, SEED_B64);
    assert.equal(saved?.name, "Example Agent");
  });

  it("rejects an invalid name locally: no request, no key created", async () => {
    const captured: Captured[] = [];
    const keyFile = await tempKeyFile();
    const d = deps(makeFetch({ entries: [], head: HEAD0 }, captured), keyFile);
    await expectError(
      registerAgent({ name: "x" }, d),
      "name must be 3 to 32 characters from A-Z a-z 0-9 space _ . -",
    );
    assert.deepEqual(captured, []);
    assert.equal(await loadKey(d), null);
  });

  it("maps a 409 already-registered body to the pinned error string", async () => {
    const keyFile = await tempKeyFile();
    const d = deps(
      makeFetch({
        entries: [],
        head: HEAD0,
        registerStatus: 409,
        registerBody: { error: { code: "already-registered", message: "this key already has a name" } },
      }),
      keyFile,
    );
    await expectError(
      registerAgent({ name: "Example Agent" }, d),
      "guestbook error: already-registered: this key already has a name",
    );
  });

  it("refuses a non-https base URL outside localhost before any request", async () => {
    const captured: Captured[] = [];
    const keyFile = await tempKeyFile();
    const d = deps(makeFetch({ entries: [], head: HEAD0 }, captured), keyFile, {
      baseUrl: "http://guestbook.example.test",
    });
    await expectError(
      registerAgent({ name: "Example Agent" }, d),
      "GUESTBOOK_BASE_URL must use https except for localhost",
    );
    assert.deepEqual(captured, []);
  });
});

/* ------------------------------------------------------------------ */
/* sign_entry                                                          */
/* ------------------------------------------------------------------ */

describe("sign_entry", () => {
  async function registeredDeps(fetchFn: FetchFn, captured?: Captured[]) {
    void captured;
    const keyFile = await tempKeyFile();
    const d = deps(fetchFn, keyFile);
    await saveKey({ ...VECTOR_RECORD, name: "Example Agent" }, d);
    return d;
  }

  it("fails with the no-key string when no key exists", async () => {
    const d = deps(makeFetch({ entries: [], head: HEAD0 }), await tempKeyFile());
    await expectError(
      signEntry({ message: "hello ledger" }, d),
      "no guestbook key on this machine — call register first",
    );
  });

  it("fails with the unregistered string when the key has no name", async () => {
    const keyFile = await tempKeyFile();
    const d = deps(makeFetch({ entries: [], head: HEAD0 }), keyFile);
    await saveKey({ ...VECTOR_RECORD }, d);
    await expectError(
      signEntry({ message: "hello ledger" }, d),
      "this key is not registered yet — call register first",
    );
  });

  it("posts the pinned post signature for the vector message and persists lastPostDate", async () => {
    const captured: Captured[] = [];
    const postBody = { seq: 7, prevHash: ZERO_HASH, entryHash: "ab".repeat(32), postedUtc: "2026-09-07T12:00:00.000Z" };
    const d = await registeredDeps(makeFetch({ entries: [], head: HEAD0, postBody }, captured));
    const out = await signEntry({ message: POST_MESSAGE }, d);
    assert.equal(out, JSON.stringify(postBody));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://agents.bluecloudcyber.com/api/guestbook/entries");
    assert.equal(captured[0].method, "POST");
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), {
      agent: FINGERPRINT,
      date: "2026-09-07",
      message: POST_MESSAGE,
      signature: POST_SIG,
    });
    const saved = await loadKey(d);
    assert.equal(saved?.lastPostDate, "2026-09-07");
    const me = JSON.parse(await whoami({}, d)) as Record<string, unknown>;
    assert.equal(me.posted_today, true);
  });

  it("validates the message locally before any request", async () => {
    const captured: Captured[] = [];
    const d = await registeredDeps(makeFetch({ entries: [], head: HEAD0 }, captured));
    await expectError(
      signEntry({ message: "see https://example.com" }, d),
      "message must not contain angle brackets or URLs",
    );
    assert.deepEqual(captured, []);
  });

  it("maps a 409 already-posted-today body to the pinned error string", async () => {
    const d = await registeredDeps(
      makeFetch({
        entries: [],
        head: HEAD0,
        postStatus: 409,
        postBody: { error: { code: "already-posted-today", message: "one entry per day" } },
      }),
    );
    await expectError(
      signEntry({ message: "second post today" }, d),
      "guestbook error: already-posted-today: one entry per day",
    );
  });

  it("maps a throwing fetch to guestbook unreachable", async () => {
    const d = await registeredDeps(throwingFetch);
    await expectError(signEntry({ message: "hello ledger" }, d), "guestbook unreachable");
  });
});

/* ------------------------------------------------------------------ */
/* read_ledger                                                         */
/* ------------------------------------------------------------------ */

function buildEntry(
  seq: number,
  prevHash: string,
  date: string,
  message: string,
  postedUtc: string,
): LedgerEntry {
  const sig = signPayload(
    vectorKey.privateKey,
    canonicalPostPayload(FINGERPRINT, date, message),
  );
  const entry: LedgerEntry = {
    agent: FINGERPRINT,
    date,
    message,
    name: "Example Agent",
    postedUtc,
    prevHash,
    publicKey: PUB_B64,
    seq,
    sig,
    v: 1,
    entryHash: "",
  };
  entry.entryHash = computeEntryHash(entry);
  return entry;
}

function buildChain(count: number): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let prev = ZERO_HASH;
  for (let i = 1; i <= count; i++) {
    const e = buildEntry(i, prev, "2026-09-07", `Ledger entry number ${i}`, "2026-09-07T12:00:00.000Z");
    out.push(e);
    prev = e.entryHash;
  }
  return out;
}

describe("read_ledger", () => {
  it("GETs entries with the default limit and the head, returning {entries, head}", async () => {
    const chain = buildChain(2);
    const head = { seq: 2, hash: chain[1].entryHash, updatedUtc: "2026-09-07T12:00:00.000Z" };
    const captured: Captured[] = [];
    const out = await readLedger({}, deps(makeFetch({ entries: chain, head }, captured), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), { entries: chain, head });
    assert.equal(captured.length, 2);
    assert.equal(captured[0].url, "https://agents.bluecloudcyber.com/api/guestbook/entries?limit=50");
    assert.equal(captured[1].url, "https://agents.bluecloudcyber.com/api/guestbook/head");
  });

  it("includes after only when given and honours limit", async () => {
    const chain = buildChain(5);
    const head = { seq: 5, hash: chain[4].entryHash, updatedUtc: "2026-09-07T12:00:00.000Z" };
    const captured: Captured[] = [];
    const out = await readLedger(
      { after: 3, limit: 2 },
      deps(makeFetch({ entries: chain, head }, captured), await tempKeyFile()),
    );
    const parsed = JSON.parse(out) as { entries: LedgerEntry[] };
    assert.deepEqual(parsed.entries.map((e) => e.seq), [4, 5]);
    assert.equal(
      captured[0].url,
      "https://agents.bluecloudcyber.com/api/guestbook/entries?after=3&limit=2",
    );
  });

  it("rejects an out-of-range after or limit before any request", async () => {
    const captured: Captured[] = [];
    const d = deps(makeFetch({ entries: [], head: HEAD0 }, captured), await tempKeyFile());
    await expectError(readLedger({ after: -1 }, d), "after must be an integer >= 0");
    await expectError(readLedger({ after: 1.5 }, d), "after must be an integer >= 0");
    await expectError(readLedger({ limit: 0 }, d), "limit must be an integer between 1 and 500");
    await expectError(readLedger({ limit: 501 }, d), "limit must be an integer between 1 and 500");
    assert.deepEqual(captured, []);
  });

  it("allows an http localhost base", async () => {
    const captured: Captured[] = [];
    const out = await readLedger(
      {},
      deps(makeFetch({ entries: [], head: HEAD0 }, captured), await tempKeyFile(), {
        baseUrl: "http://localhost:9999",
      }),
    );
    assert.deepEqual(JSON.parse(out), { entries: [], head: HEAD0 });
    assert.equal(captured[0].url, "http://localhost:9999/api/guestbook/entries?limit=50");
  });
});

/* ------------------------------------------------------------------ */
/* verify_chain                                                        */
/* ------------------------------------------------------------------ */

describe("verify_chain", () => {
  function chainState(chain: LedgerEntry[], headOverride?: Partial<{ seq: number; hash: string }>) {
    const last = chain[chain.length - 1];
    return {
      entries: chain,
      head: {
        seq: headOverride?.seq ?? (last ? last.seq : 0),
        hash: headOverride?.hash ?? (last ? last.entryHash : ZERO_HASH),
        updatedUtc: "2026-09-07T12:00:00.000Z",
      },
    };
  }

  it("verifies a valid three-entry chain end to end", async () => {
    const chain = buildChain(3);
    const out = await verifyChain({}, deps(makeFetch(chainState(chain)), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), { valid: true, checked: 3, head_seq: 3 });
  });

  it("treats an empty ledger as valid when head.seq is 0", async () => {
    const out = await verifyChain({}, deps(makeFetch(chainState([])), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), { valid: true, checked: 0, head_seq: 0 });
  });

  it("detects a tampered message as an entry hash mismatch", async () => {
    const chain = buildChain(3);
    chain[1] = { ...chain[1], message: "forged content" };
    const out = await verifyChain({}, deps(makeFetch(chainState(chain)), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), {
      valid: false,
      checked: 1,
      failure: { seq: 2, reason: "entry hash mismatch" },
    });
  });

  it("detects a broken prevHash link even when the entry is rehashed", async () => {
    const chain = buildChain(3);
    const broken: LedgerEntry = { ...chain[1], prevHash: ZERO_HASH };
    broken.entryHash = computeEntryHash(broken);
    chain[1] = broken;
    chain[2] = { ...chain[2], prevHash: broken.entryHash };
    chain[2].entryHash = computeEntryHash(chain[2]);
    const out = await verifyChain({}, deps(makeFetch(chainState(chain)), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), {
      valid: false,
      checked: 1,
      failure: { seq: 2, reason: "prevHash mismatch" },
    });
  });

  it("detects an invalid signature when the entry is rehashed", async () => {
    const chain = buildChain(3);
    const badSig = signPayload(
      vectorKey.privateKey,
      canonicalPostPayload(FINGERPRINT, "2026-09-07", "a different message"),
    );
    const forged: LedgerEntry = { ...chain[1], sig: badSig };
    forged.entryHash = computeEntryHash(forged);
    chain[1] = forged;
    chain[2] = { ...chain[2], prevHash: forged.entryHash };
    chain[2].entryHash = computeEntryHash(chain[2]);
    const out = await verifyChain({}, deps(makeFetch(chainState(chain)), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), {
      valid: false,
      checked: 1,
      failure: { seq: 2, reason: "signature invalid" },
    });
  });

  it("detects a fingerprint mismatch when the embedded key is swapped and re-signed", async () => {
    const chain = buildChain(3);
    const other = generateKey();
    const sig = signPayload(
      other.privateKey,
      canonicalPostPayload(FINGERPRINT, "2026-09-07", chain[1].message as string),
    );
    const swapped: LedgerEntry = { ...chain[1], publicKey: other.publicKey, sig };
    swapped.entryHash = computeEntryHash(swapped);
    chain[1] = swapped;
    chain[2] = { ...chain[2], prevHash: swapped.entryHash };
    chain[2].entryHash = computeEntryHash(chain[2]);
    const out = await verifyChain({}, deps(makeFetch(chainState(chain)), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), {
      valid: false,
      checked: 1,
      failure: { seq: 2, reason: "fingerprint mismatch" },
    });
  });

  it("checks a hidden entry by its stored chain position only", async () => {
    const chain = buildChain(3);
    const hidden: LedgerEntry = {
      seq: 2,
      prevHash: chain[0].entryHash,
      entryHash: chain[1].entryHash,
      hidden: true,
    };
    chain[1] = hidden;
    const out = await verifyChain({}, deps(makeFetch(chainState(chain)), await tempKeyFile()));
    assert.deepEqual(JSON.parse(out), { valid: true, checked: 3, head_seq: 3 });
  });

  it("detects a head hash mismatch after all entries pass", async () => {
    const chain = buildChain(3);
    const out = await verifyChain(
      {},
      deps(makeFetch(chainState(chain, { hash: "ff".repeat(32) })), await tempKeyFile()),
    );
    assert.deepEqual(JSON.parse(out), {
      valid: false,
      checked: 3,
      failure: { seq: 3, reason: "head hash mismatch" },
    });
  });

  it("detects a head seq mismatch", async () => {
    const chain = buildChain(3);
    const out = await verifyChain(
      {},
      deps(makeFetch(chainState(chain, { seq: 99 })), await tempKeyFile()),
    );
    assert.deepEqual(JSON.parse(out), {
      valid: false,
      checked: 3,
      failure: { seq: 99, reason: "head seq mismatch" },
    });
  });

  it("paginates with limit 500 until a short page", async () => {
    const chain = buildChain(501);
    const captured: Captured[] = [];
    const out = await verifyChain(
      {},
      deps(makeFetch(chainState(chain), captured), await tempKeyFile()),
    );
    assert.deepEqual(JSON.parse(out), { valid: true, checked: 501, head_seq: 501 });
    const gets = captured.filter((c) => c.url.includes("/api/guestbook/entries?"));
    assert.equal(gets.length, 2);
    assert.match(gets[0].url, /after=0&limit=500/);
    assert.match(gets[1].url, /after=500&limit=500/);
  });
});

/* ------------------------------------------------------------------ */
/* Upstream error mapping                                              */
/* ------------------------------------------------------------------ */

describe("upstream error mapping", () => {
  it("maps a structured {error:{code,message}} body to the pinned string", async () => {
    const d = deps(
      makeFetch({
        entries: [],
        head: HEAD0,
        getStatus: 429,
        getBody: { error: { code: "daily-cap", message: "global cap reached" } },
      }),
      await tempKeyFile(),
    );
    await expectError(readLedger({}, d), "guestbook error: daily-cap: global cap reached");
  });

  it("maps a non-JSON error body to guestbook error: HTTP <status>", async () => {
    const d = deps(
      makeFetch({ entries: [], head: HEAD0, getStatus: 503, getBody: "writes disabled page" }),
      await tempKeyFile(),
    );
    await expectError(readLedger({}, d), "guestbook error: HTTP 503");
  });

  it("maps a throwing fetch to guestbook unreachable", async () => {
    const d = deps(throwingFetch, await tempKeyFile());
    await expectError(readLedger({}, d), "guestbook unreachable");
    await expectError(verifyChain({}, d), "guestbook unreachable");
  });

  it("reads the base URL from env GUESTBOOK_BASE_URL", async () => {
    const captured: Captured[] = [];
    const d = deps(makeFetch({ entries: [], head: HEAD0 }, captured), await tempKeyFile(), {
      env: { GUESTBOOK_BASE_URL: "https://gb.example.test/" },
    });
    await readLedger({}, d);
    assert.equal(captured[0].url, "https://gb.example.test/api/guestbook/entries?limit=50");
  });
});

/* ------------------------------------------------------------------ */
/* Key file                                                            */
/* ------------------------------------------------------------------ */

describe("key file", () => {
  it("round-trips a record through saveKey/loadKey", async () => {
    const keyFile = await tempKeyFile();
    const d = deps(throwingFetch, keyFile);
    assert.equal(await loadKey(d), null);
    await saveKey({ ...VECTOR_RECORD, name: "Example Agent", lastPostDate: "2026-09-07" }, d);
    assert.deepEqual(await loadKey(d), {
      ...VECTOR_RECORD,
      name: "Example Agent",
      lastPostDate: "2026-09-07",
    });
    const raw = JSON.parse(await readFile(keyFile, "utf8")) as Record<string, unknown>;
    assert.equal(raw.seed, SEED_B64);
    assert.equal(raw.publicKey, PUB_B64);
    assert.equal(raw.fingerprint, FINGERPRINT);
  });

  it("generates distinct keys on distinct machines (files)", async () => {
    const a = generateKey();
    const b = generateKey();
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.equal(Buffer.from(a.publicKey, "base64").length, 32);
    assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  });
});

/* ------------------------------------------------------------------ */
/* CLI (spawned through tsx; only pre-request paths are exercised)     */
/* ------------------------------------------------------------------ */

function runCli(args: string[], env: Record<string, string> = {}) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return spawnSync(join(root, "node_modules", ".bin", "tsx"), ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GUESTBOOK_BASE_URL: "", GUESTBOOK_KEY_FILE: "", ...env },
  });
}

describe("guestledger CLI", () => {
  it("prints 0.1.0 for --version and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("exits 2 with usage for an unknown subcommand", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage/);
  });

  it("exits 2 for a non-JSON argument string", () => {
    const res = runCli(["whoami", "not json"]);
    assert.equal(res.status, 2);
  });

  it("exits 2 for extra arguments", () => {
    const res = runCli(["whoami", "{}", "{}"]);
    assert.equal(res.status, 2);
  });

  it("whoami against a missing temp key file exits 0 with has_key false", async () => {
    const keyFile = await tempKeyFile();
    const res = runCli(["whoami", "{}"], { GUESTBOOK_KEY_FILE: keyFile });
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout), {
      has_key: false,
      registered: false,
      posted_today: false,
    });
  });

  it("exits 1 with the no-key message for sign_entry without a key", async () => {
    const keyFile = await tempKeyFile();
    const res = runCli(["sign_entry", JSON.stringify({ message: "hello ledger" })], {
      GUESTBOOK_KEY_FILE: keyFile,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no guestbook key on this machine/);
  });

  it("exits 1 with the name message for register with an invalid name", async () => {
    const keyFile = await tempKeyFile();
    const res = runCli(["register", JSON.stringify({ name: "x" })], {
      GUESTBOOK_KEY_FILE: keyFile,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /name must be 3 to 32 characters/);
  });
});
