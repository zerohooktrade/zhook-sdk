/**
 * Pool discovery from Uniswap v4 PoolManager `Initialize` logs over public RPCs. Free endpoints cap eth_getLogs ranges
 * (thirdweb: 1,000 blocks) and Robinhood Chain makes about ten blocks a second, so scan recent windows (for example the
 * last 20,000 blocks, about 35 minutes) rather than the whole history.
 */
import { decodeEventLog, encodeEventTopics, type PublicClient } from "viem";
import { poolManagerEvents } from "./abis.js";
import { RHC, type Address } from "./chain.js";
import { poolIdOf, type PoolKey } from "./pool.js";
import type { PoolRegistry, PoolInput } from "./registry.js";
import { getLogsChunked, type LogsOptions, type RawLog } from "./rpc.js";

export interface DiscoveredPool extends PoolInput {
  id: `0x${string}`;
  key: PoolKey;
  firstBlock: number;
  initTx: string;
  sqrtPriceX96: bigint;
}

export interface DiscoverResult {
  pools: DiscoveredPool[];
  fromBlock: number;
  toBlock: number;
  /** False when some log ranges could not be read (rate limits, time budget). */
  complete: boolean;
  error: string | null;
}

const initTopic = encodeEventTopics({ abi: poolManagerEvents, eventName: "Initialize" })[0] as `0x${string}`;

/** Decode one PoolManager Initialize log into a pool. */
export function decodeInitialize(
  log: Pick<RawLog, "data" | "topics" | "blockNumber" | "transactionHash">,
): DiscoveredPool {
  const ev = decodeEventLog({
    abi: poolManagerEvents,
    eventName: "Initialize",
    data: log.data,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  const a = ev.args;
  const key: PoolKey = {
    currency0: a.currency0.toLowerCase() as Address,
    currency1: a.currency1.toLowerCase() as Address,
    fee: a.fee,
    tickSpacing: a.tickSpacing,
    hooks: a.hooks.toLowerCase() as Address,
  };
  return {
    id: poolIdOf(key),
    key,
    firstBlock: parseInt(log.blockNumber, 16),
    initTx: log.transactionHash,
    sqrtPriceX96: a.sqrtPriceX96,
  };
}

export interface DiscoverOptions extends LogsOptions {
  /** First block to scan. Default: `toBlock - blocks + 1`. */
  fromBlock?: number;
  /** Last block to scan. Default: the chain head (read with `client`). */
  toBlock?: number;
  /** Window size when fromBlock is not given (default 20,000 blocks). */
  blocks?: number;
  /** Needed to read the head when toBlock is not given. */
  client?: PublicClient;
  /** When given, discovered pools are added to it. */
  registry?: PoolRegistry;
}

/** Find pools initialized in a block range from PoolManager Initialize logs. */
export async function discoverPools(options: DiscoverOptions = {}): Promise<DiscoverResult> {
  let to = options.toBlock;
  if (to === undefined) {
    if (!options.client) throw new Error("discoverPools needs toBlock or a client to read the chain head");
    to = Number(await options.client.getBlockNumber());
  }
  const from = Math.max(0, options.fromBlock ?? to - (options.blocks ?? 20_000) + 1);
  const r = await getLogsChunked({ address: RHC.v4.poolManager, topics: [initTopic] }, from, to, options);
  const pools: DiscoveredPool[] = [];
  for (const log of r.logs) {
    try {
      pools.push(decodeInitialize(log));
    } catch {
      /* not an Initialize log */
    }
  }
  if (options.registry) options.registry.add(pools, "discovered");
  return { pools, fromBlock: from, toBlock: r.to, complete: r.complete, error: r.error };
}
