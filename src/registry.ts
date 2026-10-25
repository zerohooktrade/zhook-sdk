/**
 * Uniswap v4 pool registry. v3 pools need no registry (the factory resolves them per fee tier), but v4 pools are
 * keyed by (currency0, currency1, fee, tickSpacing, hooks) and cannot be enumerated on-chain cheaply, so the router
 * needs a list. Start from the bundled default set, pass your own, or add pools found with `discoverPools()`.
 * Only keys and activity weights live here: prices and liquidity are always re-read live before use.
 */
import { NATIVE, type Address } from "./chain.js";
import { DEFAULT_HOOK_PINS, DEFAULT_POOL_ROWS, DEFAULT_TOKENS } from "./data/pools.js";
import { poolIdOf, type PoolKey } from "./pool.js";

/** Compact pool row: [currency0, currency1, fee, tickSpacing, hooks ("" = none), positions, liquidity, swaps]. */
export type PoolRow = [string, string, number, number, string, number, string, number];

export interface PoolInput {
  key: PoolKey;
  /** PositionManager positions ever minted in this pool. */
  positions?: number;
  /** In-range liquidity when the list was made (used only to rank pools before quoting). */
  liquidity?: bigint | string;
  /** Swaps in a recent window (used only to rank pools before quoting). */
  swaps?: number;
  /** Block of the Initialize log, when known. */
  firstBlock?: number | null;
  initTx?: string | null;
}

export interface RegistryPool {
  id: `0x${string}`;
  key: PoolKey;
  positions: number;
  liquidity: bigint;
  swaps: number;
  firstBlock: number | null;
  initTx: string | null;
  source: "default" | "input" | "discovered";
}

export interface HookPin {
  /** keccak256 of the hook's runtime code when the list was made (null when it had no code). */
  codehash: string | null;
  size: number;
}

export interface HookSummary {
  hook: Address;
  pools: number;
  swaps: number;
  tokens: Address[];
  pin: HookPin | null;
}

export interface RegistryOptions {
  /** Pools to add (objects or compact rows). */
  pools?: (PoolInput | PoolRow)[];
  /** Token metadata: address → [symbol, decimals]. */
  tokens?: Record<string, [string, number]>;
  /** Hook codehash pins: hook → [codehash, size]. */
  hookPins?: Record<string, [string | null, number]>;
  /** Start from the bundled default pool set (default true). */
  includeDefaults?: boolean;
}

const lc = (a: string) => a.toLowerCase() as Address;
const pairKey = (a: string, b: string) => (lc(a) < lc(b) ? `${lc(a)}|${lc(b)}` : `${lc(b)}|${lc(a)}`);

export function rowToInput(r: PoolRow): PoolInput {
  return {
    key: {
      currency0: lc(r[0]),
      currency1: lc(r[1]),
      fee: r[2],
      tickSpacing: r[3],
      hooks: (r[4] ? lc(r[4]) : NATIVE) as Address,
    },
    positions: r[5],
    liquidity: BigInt(r[6]),
    swaps: r[7],
  };
}

export function inputToRow(p: PoolInput): PoolRow {
  const hooks = lc(p.key.hooks);
  return [
    lc(p.key.currency0),
    lc(p.key.currency1),
    p.key.fee,
    p.key.tickSpacing,
    hooks === NATIVE ? "" : hooks,
    p.positions ?? 0,
    String(p.liquidity ?? 0),
    p.swaps ?? 0,
  ];
}

export class PoolRegistry {
  private readonly byId = new Map<string, RegistryPool>();
  private readonly byPair = new Map<string, RegistryPool[]>();
  private readonly byHook = new Map<string, RegistryPool[]>();
  private readonly tokens = new Map<string, { symbol: string; decimals: number }>();
  private readonly pins = new Map<string, HookPin>();

  constructor(options: RegistryOptions = {}) {
    if (options.includeDefaults !== false) {
      this.addTokens(DEFAULT_TOKENS);
      this.addHookPins(DEFAULT_HOOK_PINS);
      this.add(DEFAULT_POOL_ROWS.map(rowToInput), "default");
    }
    if (options.tokens) this.addTokens(options.tokens);
    if (options.hookPins) this.addHookPins(options.hookPins);
    if (options.pools)
      this.add(
        options.pools.map((p) => (Array.isArray(p) ? rowToInput(p) : p)),
        "input",
      );
  }

  /** Add pools; a pool already present (same PoolId) keeps its first entry. Returns how many were new. */
  add(pools: PoolInput[], source: RegistryPool["source"] = "input"): number {
    let added = 0;
    for (const p of pools) {
      const key: PoolKey = {
        currency0: lc(p.key.currency0),
        currency1: lc(p.key.currency1),
        fee: p.key.fee,
        tickSpacing: p.key.tickSpacing,
        hooks: lc(p.key.hooks),
      };
      const id = poolIdOf(key);
      if (this.byId.has(id)) continue;
      const pool: RegistryPool = {
        id,
        key,
        positions: p.positions ?? 0,
        liquidity: BigInt(p.liquidity ?? 0),
        swaps: p.swaps ?? 0,
        firstBlock: p.firstBlock ?? null,
        initTx: p.initTx ?? null,
        source,
      };
      this.byId.set(id, pool);
      const k = pairKey(key.currency0, key.currency1);
      (this.byPair.get(k) ?? this.byPair.set(k, []).get(k)!).push(pool);
      if (key.hooks !== NATIVE)
        (this.byHook.get(key.hooks) ?? this.byHook.set(key.hooks, []).get(key.hooks)!).push(pool);
      added++;
    }
    return added;
  }

  addTokens(tokens: Record<string, [string, number]>) {
    for (const [a, [symbol, decimals]] of Object.entries(tokens)) this.tokens.set(lc(a), { symbol, decimals });
  }

  addHookPins(pins: Record<string, [string | null, number]>) {
    for (const [h, [codehash, size]] of Object.entries(pins)) this.pins.set(lc(h), { codehash, size });
  }

  get size() {
    return this.byId.size;
  }

  all(): RegistryPool[] {
    return [...this.byId.values()];
  }

  /** Every known v4 pool of a pair (either order). */
  forPair(a: string, b: string): RegistryPool[] {
    return [...(this.byPair.get(pairKey(a, b)) ?? [])];
  }

  /** Every known v4 pool that uses a hook. */
  forHook(hook: string): RegistryPool[] {
    return [...(this.byHook.get(lc(hook)) ?? [])];
  }

  get(id: string): RegistryPool | null {
    return this.byId.get(id.toLowerCase()) ?? null;
  }

  token(address: string): { symbol: string; decimals: number } | null {
    return this.tokens.get(lc(address)) ?? null;
  }

  hookPin(hook: string): HookPin | null {
    return this.pins.get(lc(hook)) ?? null;
  }

  /** Every non-native currency in the registry's pools, lowercase. */
  tokenAddresses(): Address[] {
    const out = new Set<Address>();
    for (const p of this.byId.values())
      for (const t of [p.key.currency0, p.key.currency1]) if (t !== NATIVE) out.add(t);
    return [...out];
  }

  /** One row per hook contract, ranked by swaps, then pool count. */
  hooks(): HookSummary[] {
    const rows: HookSummary[] = [];
    for (const [hook, list] of this.byHook) {
      const tokens = new Set<Address>();
      for (const p of list) {
        tokens.add(p.key.currency0);
        tokens.add(p.key.currency1);
      }
      rows.push({
        hook: hook as Address,
        pools: list.length,
        swaps: list.reduce((s, p) => s + p.swaps, 0),
        tokens: [...tokens],
        pin: this.hookPin(hook),
      });
    }
    return rows.sort((x, y) => y.swaps - x.swaps || y.pools - x.pools);
  }

  /** Compact rows for persisting the registry (for example after discovery). */
  toRows(): PoolRow[] {
    return this.all().map((p) => inputToRow(p));
  }
}

/** A registry holding the bundled default pool set. */
export function defaultRegistry(): PoolRegistry {
  return new PoolRegistry();
}
