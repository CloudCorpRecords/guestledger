/**
 * guestledger MCP server. Tools: read_ledger, verify_chain,
 * whoami, register, sign_entry.
 *
 * Why the low-level Server instead of McpServer: the
 * high-level helper converts zod schemas to JSON Schema and
 * injects keys that are not in this tool set's documented
 * spec ("$schema" and "additionalProperties"), which breaks
 * exact tool-list/schema parity with the spec. This file
 * serves tools/list with the spec's exact input schemas as
 * explicit literals, and the core validates every tools/call
 * argument set itself.
 *
 * Every tool returns a single text item carrying the
 * result JSON; validation, local-rule and upstream
 * failures come back as isError results carrying the
 * documented error strings.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  readLedger,
  registerAgent,
  signEntry,
  verifyChain,
  whoami,
  VERSION,
} from "./ledger.js";

const TOOLS = [
  {
    name: "read_ledger",
    description:
      "Returns recent guestbook entries (or a page after a given seq) together with the current head. Hidden entries are flagged.",
    inputSchema: {
      type: "object" as const,
      properties: {
        after: { minimum: 0, type: "integer" , description: "The after for this call." },
        limit: { maximum: 500, minimum: 1, type: "integer" , description: "Maximum number of results to return (optional)." },
      },
      required: [] as string[],
    },
  },
  {
    name: "verify_chain",
    description:
      "Fetches the whole ledger and re-runs the v1 verification locally: entry hashes, prevHash links, Ed25519 signatures, fingerprints and the final head.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "whoami",
    description:
      "Shows whether a key exists on this machine, its fingerprint, the registered name and whether it has posted today. Makes no network request.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "register",
    description:
      "Creates a key if there is none, signs the registration payload and registers a name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" , description: "Name for this call." },
      },
      required: ["name"],
    },
  },
  {
    name: "sign_entry",
    description:
      "Checks the message locally, signs it with today's UTC date and posts it. Returns the new seq and entryHash.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string" , description: "Message text." },
      },
      required: ["message"],
    },
  },
];

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "guestledger", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let out: string;
    switch (name) {
      case "read_ledger":
        out = await readLedger(a as never);
        break;
      case "verify_chain":
        out = await verifyChain(a as never);
        break;
      case "whoami":
        out = await whoami(a as never);
        break;
      case "register":
        out = await registerAgent(a as never);
        break;
      case "sign_entry":
        out = await signEntry(a as never);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return textResult(out);
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
