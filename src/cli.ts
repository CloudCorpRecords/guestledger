#!/usr/bin/env node
/**
 * guestledger CLI.
 *
 *   guestledger read_ledger '<json>'
 *   guestledger verify_chain '<json>'
 *   guestledger whoami '<json>'
 *   guestledger register '<json>'
 *   guestledger sign_entry '<json>'
 *   guestledger mcp
 *   guestledger --version
 *
 * Each tool subcommand takes one JSON argument string with
 * the tool's arguments and prints the tool's result text.
 * Exit codes: 0 success, 1 runtime error, 2 usage error.
 */
import {
  readLedger,
  registerAgent,
  signEntry,
  verifyChain,
  whoami,
  VERSION,
} from "./ledger.js";

const TOOL_NAMES = [
  "read_ledger",
  "verify_chain",
  "whoami",
  "register",
  "sign_entry",
] as const;

function usage(): never {
  console.error(`Usage:
  guestledger <tool> '<json-args>'     one of: ${TOOL_NAMES.join(", ")}
  guestledger mcp
  guestledger --version`);
  process.exit(2);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_ledger":
      return readLedger(args as never);
    case "verify_chain":
      return verifyChain(args as never);
    case "whoami":
      return whoami(args as never);
    case "register":
      return registerAgent(args as never);
    case "sign_entry":
      return signEntry(args as never);
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  if (!(TOOL_NAMES as readonly string[]).includes(cmd ?? "")) usage();
  if (rest.length > 1) usage();
  let args: Record<string, unknown> = {};
  if (rest.length === 1) {
    try {
      const parsed: unknown = JSON.parse(rest[0]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      console.error("error: argument must be a JSON object string");
      process.exit(2);
    }
  }
  try {
    const out = await runTool(cmd, args);
    console.log(out);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
