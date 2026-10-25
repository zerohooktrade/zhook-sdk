/**
 * USD prices and Robinhood Stock Tokens.
 *
 * Prices: the best executable rate for one whole token right now, read with the same Uniswap quoters as the router
 * (QuoterV2 + V4Quoter): directly against USDG, or against ETH and then ETH → USDG. USDG is counted as 1 USD.
 *
 * Stock Tokens: Robinhood's tokenized stocks on Robinhood Chain are BeaconProxy contracts whose beacon address is an
 * immutable in the proxy bytecode, so every official Stock Token has exactly the same runtime code. A token is listed
 * only when its codehash equals STOCK_PROXY_CODEHASH (checked 2026-10-25; beacon
 * 0xe10b6f6b275de231345c20d14ab812db62151b00). Copycats with the same symbol have different code and are never listed.
 */
import { formatUnits, getAddress } from "viem";
import { erc20Abi } from "./abis.js";
import { NATIVE, RHC, type Address } from "./chain.js";
import { STOCK_CANDIDATES } from "./data/stocks.js";
import { codehashOf } from "./pins.js";
import { candidates, quoteMany, tokenInfo, type EngineContext } from "./quote.js";

const USDG = RHC.usdg.toLowerCase() as Address;
const WETH = RHC.weth.toLowerCase() as Address;
const lc = (a: string) => a.toLowerCase() as Address;

export const STOCK_BEACON = "0xe10b6f6b275de231345c20d14ab812db62151b00";
export const STOCK_PROXY_CODEHASH = "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630";

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

export interface PriceQuote {
  address: string;
  symbol: string;
  decimals: number;
  /** USD per whole token (USDG = 1), null when no Uniswap route prices it. */
  priceUsd: number | null;
  via: "usdg" | "eth" | "par" | null;
  /** Pool that gave the price. */
  venue: string | null;
  block: number;
}

/** Best output per whole input token on one direct hop a → b, probing sizes from 1/1000 token up to 1M tokens. */
async function directRate(
  ctx: EngineContext,
  a: Address,
  b: Address,
  decIn: number,
  decOut: number,
): Promise<{ rate: number; venue: string } | null> {
  const all = await candidates(ctx, a, b, true);
  // All v3 tiers plus the 6 most-used v4 pools keeps one eth_call batch small.
  const cands = [...all.filter((c) => c.venue === "v3"), ...all.filter((c) => c.venue === "v4").slice(0, 6)];
  if (!cands.length) return null;
  // The smallest size whose output has at least 5 significant digits wins (small enough to keep price impact
  // negligible, large enough that a cheap token isn't rounded to dust).
  const unit = 10n ** BigInt(decIn);
  const sizes = [decIn >= 3 ? unit / 1000n : 1n, unit, unit * 1000n, unit * 1_000_000n];
  const outs = await quoteMany(
    ctx,
    cands.flatMap((c) => sizes.map((amountIn) => ({ hop: c.hop, amountIn }))),
  );
  let fallback: { rate: number; venue: string } | null = null;
  for (let s = 0; s < sizes.length; s++) {
    let best: { rate: number; venue: string } | null = null;
    for (let i = 0; i < cands.length; i++) {
      const o = outs[i * sizes.length + s];
      if (!o || o <= 0n) continue;
      const rate = Number(formatUnits(o, decOut)) / Number(formatUnits(sizes[s]!, decIn));
      if (o >= 10_000n && (!best || rate > best.rate)) best = { rate, venue: cands[i]!.label };
      if (!fallback) fallback = { rate, venue: cands[i]!.label };
    }
    if (best) return best;
  }
  return fallback;
}

function ethUsd(ctx: EngineContext) {
  return ctx.cache.get("px:eth", 30, () => directRate(ctx, NATIVE, USDG, 18, 6));
}

/** USD price of one whole token (address or "ETH"). */
export async function priceOf(ctx: EngineContext, address: string): Promise<PriceQuote> {
  const t = await tokenInfo(ctx, address);
  const a = lc(t.address);
  return ctx.cache.get(`px:${a}`, 60, async (): Promise<PriceQuote> => {
    const block = Number(await ctx.client.getBlockNumber());
    const base = { address: t.address, symbol: t.symbol, decimals: t.decimals, block };
    if (a === USDG) return { ...base, priceUsd: 1, via: "par", venue: "USDG = 1 USD" };
    const eth = await ethUsd(ctx);
    if (a === NATIVE || a === WETH)
      return { ...base, priceUsd: eth?.rate ?? null, via: eth ? "usdg" : null, venue: eth?.venue ?? null };
    const [d, e] = await Promise.all([
      directRate(ctx, a, USDG, t.decimals, 6).catch(() => null),
      directRate(ctx, a, NATIVE, t.decimals, 18).catch(() => null),
    ]);
    const viaEth = e && eth ? { rate: e.rate * eth.rate, venue: e.venue } : null;
    const pick =
      d && (!viaEth || d.rate >= viaEth.rate)
        ? { ...d, via: "usdg" as const }
        : viaEth
          ? { ...viaEth, via: "eth" as const }
          : null;
    return { ...base, priceUsd: pick?.rate ?? null, via: pick?.via ?? null, venue: pick?.venue ?? null };
  });
}

/** Prices for many tokens; a token that fails gets priceUsd null instead of failing the batch. */
export async function prices(ctx: EngineContext, addresses: string[]): Promise<PriceQuote[]> {
  return mapLimit(addresses, 6, (a) =>
    priceOf(ctx, a).catch(
      () =>
        ({
          address: a,
          symbol: "?",
          decimals: 18,
          priceUsd: null,
          via: null,
          venue: null,
          block: 0,
        }) satisfies PriceQuote,
    ),
  );
}

export interface StockToken {
  address: Address;
  symbol: string;
  /** Company or fund name without the "• Robinhood Token" suffix. */
  name: string;
  decimals: number;
  totalSupply: string;
}

export interface StockTokenList {
  tokens: StockToken[];
  /** Addresses whose code was checked. */
  scanned: number;
  checkedAt: string;
  beacon: string;
  codehash: string;
}

/**
 * Robinhood Stock Tokens among the bundled candidates, `extra` addresses and (when `scanRegistry`) every registry
 * token whose name ends in "Robinhood Token". Only exact proxy-codehash matches are returned.
 */
export async function stockTokens(
  ctx: EngineContext,
  options: { extra?: string[]; scanRegistry?: boolean } = {},
): Promise<StockTokenList> {
  const key = `stocks:${options.scanRegistry ? 1 : 0}:${(options.extra ?? []).map(lc).sort().join(",")}`;
  return ctx.cache.get(key, 6 * 3600, async () => {
    const c = ctx.client;
    const cand = new Set<Address>([...STOCK_CANDIDATES, ...(options.extra ?? [])].map(lc));
    if (options.scanRegistry) {
      const all = ctx.registry.tokenAddresses().filter((a) => !cand.has(a));
      for (let i = 0; i < all.length; i += 400) {
        const slice = all.slice(i, i + 400);
        const r = await c
          .multicall({
            contracts: slice.map((address) => ({ address, abi: erc20Abi, functionName: "name" as const })),
            allowFailure: true,
          })
          .catch(() => slice.map(() => ({ status: "failure" as const, result: undefined })));
        r.forEach((x, k) => {
          if (x.status === "success" && String(x.result).includes("Robinhood Token")) cand.add(slice[k]!);
        });
      }
    }
    const list = [...cand].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
    const codes = await mapLimit(list, 8, (a) => c.getCode({ address: a }).catch(() => undefined));
    const verified = list.filter((_, i) => codehashOf(codes[i]) === STOCK_PROXY_CODEHASH);
    const fns = ["name", "symbol", "decimals", "totalSupply"] as const;
    const meta = await c.multicall({
      contracts: verified.flatMap((address) => fns.map((functionName) => ({ address, abi: erc20Abi, functionName }))),
      allowFailure: true,
    });
    const tokens: StockToken[] = verified.map((a, i) => {
      const r = (k: number) => {
        const m = meta[i * 4 + k];
        return m && m.status === "success" ? m.result : null;
      };
      return {
        address: getAddress(a) as Address,
        name: String(r(0) ?? "").replace(/\s*•\s*Robinhood Token\s*$/, ""),
        symbol: String(r(1) ?? "?"),
        decimals: Number(r(2) ?? 18),
        totalSupply: String(r(3) ?? "0"),
      };
    });
    tokens.sort((x, y) => x.symbol.localeCompare(y.symbol));
    return {
      tokens,
      scanned: list.length,
      checkedAt: new Date(ctx.now()).toISOString(),
      beacon: STOCK_BEACON,
      codehash: STOCK_PROXY_CODEHASH,
    };
  });
}

/** True when `address` carries the official Robinhood Stock Token proxy code. */
export async function isStockToken(ctx: EngineContext, address: string): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const code = await ctx.client.getCode({ address: address as Address }).catch(() => undefined);
  return codehashOf(code) === STOCK_PROXY_CODEHASH;
}
