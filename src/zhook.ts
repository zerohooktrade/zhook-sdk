import type { PublicClient } from "viem";
import { TtlCache } from "./cache.js";
import { RHC, type Address } from "./chain.js";
import { discoverPools, type DiscoverOptions, type DiscoverResult } from "./discover.js";
import { isStockToken, priceOf, prices, stockTokens, type PriceQuote, type StockTokenList } from "./market.js";
import { buildPassport, type PassportOptions } from "./passport.js";
import type { Passport } from "./passport-rules.js";
import { checkPins, type PinCheck } from "./pins.js";
import { readPoolState, type PoolState } from "./pool.js";
import {
  quoteRoute,
  tokenInfo,
  type EngineContext,
  type QuoteParams,
  type QuoteResponse,
  type TokenInfo,
} from "./quote.js";
import { PoolRegistry, type PoolInput, type PoolRow } from "./registry.js";
import { createClient } from "./rpc.js";
import {
  approvalStatus,
  approvalTxs,
  simulateTx,
  type ApprovalStatus,
  type SimulateParams,
  type Simulation,
  type UnsignedTx,
} from "./simulate.js";

export interface ZhookOptions {
  /** A viem public client for Robinhood Chain. Default: one over `rpcUrls` or the public RPCs. */
  client?: PublicClient;
  /** Read RPC URLs when no client is given. */
  rpcUrls?: string[];
  /** Pool registry to route over. Default: the bundled set plus `pools`. */
  registry?: PoolRegistry;
  /** Extra v4 pools (objects or compact rows) added to the default registry. */
  pools?: (PoolInput | PoolRow)[];
  /** Start from the bundled default pool set (default true). Ignored when `registry` is given. */
  includeDefaultPools?: boolean;
  /** Clock in milliseconds (deadlines, timestamps). */
  now?: () => number;
}

/**
 * Router for Robinhood Chain: best-price quotes across Uniswap v3, v4 and hooked pools, Universal Router calldata,
 * pinned-code checks, simulation, prices, Stock Tokens and Hook Passports. Read-only: it never signs or sends.
 */
export class Zhook {
  readonly chain = RHC;
  readonly client: PublicClient;
  readonly registry: PoolRegistry;
  private readonly ctx: EngineContext;

  constructor(options: ZhookOptions = {}) {
    this.client = options.client ?? createClient(options.rpcUrls ? { rpcUrls: options.rpcUrls } : {});
    this.registry =
      options.registry ??
      new PoolRegistry({
        includeDefaults: options.includeDefaultPools !== false,
        ...(options.pools ? { pools: options.pools } : {}),
      });
    this.ctx = { client: this.client, registry: this.registry, cache: new TtlCache(), now: options.now ?? Date.now };
  }

  /** Best route, limits, pin and hook checks, and calldata (unless a hard limit withholds it). */
  quote(params: QuoteParams): Promise<QuoteResponse> {
    return quoteRoute(this.ctx, params);
  }

  /** Same as `quote`, at a past block (needs an archive RPC). Pins are still checked at the latest block. */
  quoteAt(blockNumber: bigint, params: QuoteParams): Promise<QuoteResponse> {
    return quoteRoute({ ...this.ctx, blockNumber }, params);
  }

  tokenInfo(address: string): Promise<TokenInfo> {
    return tokenInfo(this.ctx, address);
  }

  /** Re-read every pinned contract's code (cached for 5 minutes). */
  checkPins(fresh = false): Promise<PinCheck[]> {
    if (fresh) this.ctx.cache.clear();
    return this.ctx.cache.get("pins", 300, () => checkPins(this.client));
  }

  /** eth_call + eth_estimateGas of a transaction from `from`. */
  simulate(params: SimulateParams): Promise<Simulation> {
    return simulateTx(this.client, params);
  }

  approvalStatus(owner: Address, token: Address, amount: bigint): Promise<ApprovalStatus> {
    return approvalStatus(this.client, owner, token, amount, this.ctx.now());
  }

  approvalTxs(token: Address, options: { amount?: bigint; expiration?: number } = {}): UnsignedTx[] {
    return approvalTxs(token, { ...options, now: this.ctx.now() });
  }

  price(address: string): Promise<PriceQuote> {
    return priceOf(this.ctx, address);
  }

  prices(addresses: string[]): Promise<PriceQuote[]> {
    return prices(this.ctx, addresses);
  }

  stockTokens(options: { extra?: string[]; scanRegistry?: boolean } = {}): Promise<StockTokenList> {
    return stockTokens(this.ctx, options);
  }

  isStockToken(address: string): Promise<boolean> {
    return isStockToken(this.ctx, address);
  }

  hookPassport(hook: string, options: PassportOptions = {}): Promise<Passport> {
    return buildPassport(this.ctx, hook, options);
  }

  poolState(poolId: string): Promise<PoolState> {
    return readPoolState(this.client, poolId, { lookup: (id) => this.registry.get(id)?.key ?? null });
  }

  /** Scan recent PoolManager Initialize logs and add the pools found to this router's registry. */
  discoverPools(options: Omit<DiscoverOptions, "registry" | "client"> = {}): Promise<DiscoverResult> {
    return discoverPools({ ...options, client: this.client, registry: this.registry });
  }
}

export function createZhook(options: ZhookOptions = {}): Zhook {
  return new Zhook(options);
}
