import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient } from "viem";
import { RHC, type ChainConfig } from "./chain.js";

export interface ClientOptions {
  /** Read RPC URLs, tried in order. Defaults to the chain's public RPCs. */
  rpcUrls?: string[];
  /** Per-request timeout in milliseconds (default 12,000). */
  timeoutMs?: number;
  chain?: ChainConfig;
}

/** viem chain definition for Robinhood Chain (with Multicall3). */
export function viemChain(chain: ChainConfig = RHC, rpcUrls: string[] = chain.rpcs): Chain {
  return defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: chain.native, symbol: chain.native, decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
    blockExplorers: { default: { name: "Blockscout", url: chain.explorer } },
    contracts: { multicall3: { address: chain.multicall3 } },
  });
}

/** A viem public client that falls back across the given (or default public) RPCs. */
export function createClient(options: ClientOptions = {}): PublicClient {
  const chain = options.chain ?? RHC;
  const urls = options.rpcUrls?.length ? options.rpcUrls : chain.rpcs;
  return createPublicClient({
    chain: viemChain(chain, urls),
    transport: fallback(
      urls.map((url) => http(url, { timeout: options.timeoutMs ?? 12_000, retryCount: 0 })),
      { retryCount: 1 },
    ),
  }) as PublicClient;
}

export type RawLog = {
  data: `0x${string}`;
  topics: `0x${string}`[];
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
  address: `0x${string}`;
};

/** Plain JSON-RPC over fetch, trying each URL in order. Errors from every URL are kept. */
export async function rawRpc(urls: string[], method: string, params: unknown[], timeoutMs = 20_000): Promise<unknown> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 80)}`);
      const j = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      return j.result;
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).message}`.slice(0, 160));
    }
  }
  throw new Error(errors.join(" | "));
}

export interface LogsOptions {
  /** eth_getLogs RPC URLs (default: the chain's public log RPCs). */
  urls?: string[];
  /** Max blocks per call (default: the chain's logSpan). */
  span?: number;
  /** Total time budget in milliseconds (default 25,000). */
  budgetMs?: number;
  /** Parallel requests (default 4). */
  concurrency?: number;
  chain?: ChainConfig;
}

/**
 * eth_getLogs over [from, to] in chunks, a few at a time; a failing chunk is retried once, then split in half (down to
 * 100 blocks) before giving up. Returns the logs sorted by position plus whether every chunk succeeded.
 */
export async function getLogsChunked(
  filter: { address?: `0x${string}`; topics: (`0x${string}` | `0x${string}`[] | null)[] },
  from: number,
  to: number,
  options: LogsOptions = {},
): Promise<{ logs: RawLog[]; complete: boolean; error: string | null; to: number }> {
  const chain = options.chain ?? RHC;
  const urls = options.urls?.length ? options.urls : chain.logRpcs;
  const span = options.span ?? chain.logSpan;
  const deadline = Date.now() + (options.budgetMs ?? 25_000);
  // Stay a few seconds behind head: load-balanced public RPCs return [] for a range past a lagging node's head.
  to = Math.max(from, to - Math.ceil(5 / chain.blockTime));
  const queue: [number, number][] = [];
  for (let a = from; a <= to; a += span) queue.push([a, Math.min(to, a + span - 1)]);
  const logs: RawLog[] = [];
  let complete = true;
  let error: string | null = null;
  const one = async ([a, b]: [number, number], attempt = 0): Promise<void> => {
    if (Date.now() > deadline) {
      complete = false;
      error ??= "time budget for log queries ran out";
      return;
    }
    try {
      const r = (await rawRpc(
        urls,
        "eth_getLogs",
        [{ ...filter, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
        Math.min(15_000, Math.max(1_000, deadline - Date.now())),
      )) as RawLog[];
      logs.push(...r);
    } catch (e) {
      // Public log RPCs rate-limit bursts: retry the same range once before splitting it.
      if (attempt === 0 && Date.now() + 1500 < deadline) {
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
        return one([a, b], 1);
      }
      if (b - a > 100 && Date.now() < deadline) {
        const mid = Math.floor((a + b) / 2);
        await one([a, mid]);
        await one([mid + 1, b]);
      } else {
        complete = false;
        error = ((e as Error).message ?? "log query failed").split("\n")[0]!.slice(0, 160);
      }
    }
  };
  const workers = Array.from({ length: options.concurrency ?? 4 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) await one(r);
  });
  await Promise.all(workers);
  logs.sort(
    (x, y) =>
      parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16),
  );
  return { logs, complete, error, to };
}
