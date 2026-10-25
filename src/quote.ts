/**
 * Best-price quote across Uniswap v3 (QuoterV2, fee tiers 100/500/3000/10000) and v4 (V4Quoter, every registry pool
 * of the pair, hooked or not) on Robinhood Chain, with:
 *  - a two-way split search over the two best direct pools (10 % steps),
 *  - two-hop routes through USDG and ETH,
 *  - price impact from a 1/1000-size probe of the same route (pool fees cancel out),
 *  - pinned-contract and hook-code checks,
 *  - Universal Router calldata (route.ts) and, when `from` is given, an eth_call + eth_estimateGas simulation.
 * All prices come from quoter eth_calls; nothing is modelled.
 */
import { formatUnits, getAddress, parseUnits, type Hex, type PublicClient } from "viem";
import { erc20Abi, v3FactoryAbi, v3QuoterAbi, v4QuoterAbi } from "./abis.js";
import type { TtlCache } from "./cache.js";
import { EIP1967_IMPL_SLOT, NATIVE, RHC, V3_FEES, type Address } from "./chain.js";
import { ZhookError } from "./errors.js";
import { decodeFlags, FLAGS } from "./permissions.js";
import { checkPins, codehashOf, type PinCheck } from "./pins.js";
import { feeLabel, type PoolKey } from "./pool.js";
import type { PoolRegistry, RegistryPool } from "./registry.js";
import {
  buildExecute,
  DEFAULT_SLIPPAGE_BPS,
  hopIn,
  MAX_INTEGRATOR_FEE_BPS,
  MAX_SLIPPAGE_BPS,
  minOutFor,
  type Hop,
  type Leg,
} from "./route.js";
import { simulateTx, type Simulation } from "./simulate.js";

const chain = RHC;
const WETH = chain.weth.toLowerCase() as Address;
const USDG = chain.usdg.toLowerCase() as Address;
const lc = (a: string) => a.toLowerCase() as Address;
const isEth = (a: string) => lc(a) === NATIVE;

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  native?: boolean;
}

export interface HookCheck {
  hook: Address;
  /** keccak256(runtime code) now. */
  codehash: string | null;
  /** Codehash recorded in the pool list (null when the list has no pin for this hook). */
  pinned: string | null;
  status: "match" | "changed" | "new" | "no-code";
  flags: string[];
  proxy: boolean;
}

export interface CandidateView {
  label: string;
  venue: "v3" | "v4";
  hooked: boolean;
  amountOut: string | null;
  error?: string;
}

export interface SwapTx {
  to: Address;
  data: Hex;
  value: string;
  commands: string[];
  deadline: number;
}

export interface QuoteResponse {
  chainId: number;
  block: number;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountInRaw: string;
  amountOut: string;
  amountOutRaw: string;
  /** After the integrator fee. */
  amountOutAfterFee: string;
  minOut: string;
  minOutRaw: string;
  slippageBps: number;
  feeBps: number;
  feeRecipient: Address | null;
  priceImpactPct: number | null;
  kind: "single" | "split" | "multi-hop";
  legs: Leg[];
  /** Every direct candidate priced with the full amount, best first. */
  candidates: CandidateView[];
  /** Per hub (USDG / ETH): pools of tokenIn → hub and hub → tokenOut, priced. */
  hubCandidates: { hub: Address; symbol: string; decimals: number; first: CandidateView[]; second: CandidateView[] }[];
  /** Best route through Uniswap pools without a hook (the Proof of Execution baseline). */
  bestUnhookedOut: string | null;
  gasEstimate: string | null;
  simulation: Simulation | null;
  pins: PinCheck[];
  pinsOk: boolean;
  hooks: HookCheck[];
  warnings: { level: "high" | "medium" | "info"; message: string }[];
  /** Hard-limit violations. When any is present `tx` is null. */
  blocked: string[];
  tx: SwapTx | null;
  txNote: string | null;
  /** ERC-20 input needs an allowance to Permit2 and a Permit2 allowance to the router (see `approvalTxs`). */
  approval: { token: Address; spender: Address; permit2: Address } | null;
}

export interface QuoteParams {
  /** Token address, or "ETH" for native ETH. */
  tokenIn: string;
  tokenOut: string;
  /** Positive decimal in tokenIn units, for example "0.5". */
  amount: string;
  /** Slippage in basis points, 1 to 300 (default 50). Enforced on-chain by SWEEP's minimum. */
  slippageBps?: number | string;
  /** Integrator fee in basis points, 0 to 50. */
  feeBps?: number | string;
  feeRecipient?: string;
  /** Wallet that will sign: enables an eth_call + eth_estimateGas simulation of the calldata from it. */
  from?: string;
  /** Route through hooked v4 pools (default true). */
  hooks?: boolean;
  /** Seconds until the router deadline (default 1,200). */
  deadlineSeconds?: number;
  /** Hard limit: no calldata when price impact is above this (or cannot be measured). */
  maxPriceImpactPct?: number;
  /** Hard limit: no calldata when the guaranteed minimum is below this (decimal, tokenOut units). */
  minAmountOut?: string;
  /** Hard limit: no calldata when a hook in the route is not pinned or its code changed (default false). */
  pinnedHooksOnly?: boolean;
}

/** A pool that can carry tokenIn → tokenOut in one hop (in the venue's own currency forms). */
export interface Candidate {
  label: string;
  venue: "v3" | "v4";
  hooked: boolean;
  hop: Hop;
  /** For sorting v4 candidates before quoting. */
  weight: bigint;
}

interface Plan {
  kind: QuoteResponse["kind"];
  legs: { amountIn: bigint; amountOut: bigint; hops: Hop[]; cands: Candidate[] }[];
  out: bigint;
}

export interface EngineContext {
  client: PublicClient;
  registry: PoolRegistry;
  cache: TtlCache;
  /** Quote at a past block (needs an archive RPC). */
  blockNumber?: bigint;
  now: () => number;
}

export async function tokenInfo(ctx: EngineContext, address: string): Promise<TokenInfo> {
  if (isEth(address) || address.toLowerCase() === "eth")
    return { address: NATIVE, symbol: "ETH", decimals: 18, native: true };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ZhookError(400, `Not a token address: ${address}`);
  const a = lc(address);
  if (a === USDG) return { address: getAddress(a), symbol: "USDG", decimals: 6 };
  if (a === WETH) return { address: getAddress(a), symbol: "WETH", decimals: 18 };
  const s = ctx.registry.token(a);
  if (s) return { address: getAddress(a), symbol: s.symbol, decimals: s.decimals };
  return ctx.cache.get(`token:${a}`, 3600, async () => {
    const [symbol, decimals] = await Promise.all([
      ctx.client.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
      ctx.client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
    ]);
    if (decimals === null)
      throw new ZhookError(400, `${a} does not answer decimals(): not an ERC-20 on Robinhood Chain`);
    return { address: getAddress(a), symbol: String(symbol ?? "?").slice(0, 16), decimals: Number(decimals) };
  });
}

function v4Candidate(p: RegistryPool, currencyIn: Address): Candidate {
  const hooked = lc(p.key.hooks) !== NATIVE;
  return {
    label: `Uniswap v4 · ${feeLabel(p.key.fee)}${hooked ? ` · hook ${p.key.hooks.slice(0, 6)}…${p.key.hooks.slice(-4)}` : ""}`,
    venue: "v4",
    hooked,
    weight: BigInt(p.swaps) * 10n ** 30n + p.liquidity,
    hop: { venue: "v4", poolId: p.id, key: p.key, zeroForOne: lc(p.key.currency0) === lc(currencyIn) },
  };
}

/** Forms a currency can take inside a route: ETH is native in v4 and WETH in v3; WETH can also enter native v4 pools. */
export async function candidates(
  ctx: EngineContext,
  a: Address,
  b: Address,
  includeHooked: boolean,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const va = isEth(a) ? WETH : a;
  const vb = isEth(b) ? WETH : b;
  if (va !== vb) {
    const pools = await ctx.client.multicall({
      contracts: V3_FEES.map((fee) => ({
        address: chain.v3.factory,
        abi: v3FactoryAbi,
        functionName: "getPool" as const,
        args: [va, vb, fee] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    });
    pools.forEach((r, i) => {
      if (r.status === "success" && !/^0x0{40}$/i.test(r.result))
        out.push({
          label: `Uniswap v3 · ${V3_FEES[i]! / 10_000}%`,
          venue: "v3",
          hooked: false,
          weight: 0n,
          hop: { venue: "v3", pool: r.result, tokenIn: va, tokenOut: vb, fee: V3_FEES[i]! },
        });
    });
  }
  // v4: the pair itself, plus the WETH↔native variants the encoder can bridge.
  const formsA = isEth(a) ? [NATIVE, WETH] : a === WETH ? [WETH, NATIVE] : [a];
  const formsB = isEth(b) ? [NATIVE, WETH] : b === WETH ? [WETH, NATIVE] : [b];
  const seen = new Set<string>();
  for (const fa of formsA)
    for (const fb of formsB) {
      if (fa === fb) continue;
      for (const p of ctx.registry.forPair(fa, fb)) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const hooked = lc(p.key.hooks) !== NATIVE;
        if (hooked && !includeHooked) continue;
        out.push(v4Candidate(p, fa));
      }
    }
  // Keep the quote batch bounded: all v3, the 10 deepest unhooked v4 pools and the 8 most-used hooked ones.
  const byWeight = (x: Candidate, y: Candidate) => (y.weight > x.weight ? 1 : -1);
  const v3 = out.filter((c) => c.venue === "v3");
  const plain = out
    .filter((c) => c.venue === "v4" && !c.hooked)
    .sort(byWeight)
    .slice(0, 10);
  const hooked = out
    .filter((c) => c.hooked)
    .sort(byWeight)
    .slice(0, 8);
  return [...v3, ...plain, ...hooked];
}

/**
 * Quote many (hop, amountIn) pairs through Multicall3, a few per eth_call (a deep quote can burn millions of gas and a
 * whole batch would hit the node's eth_call gas cap). null = reverted / no liquidity.
 */
export async function quoteMany(
  ctx: EngineContext,
  reqs: { hop: Hop; amountIn: bigint }[],
): Promise<(bigint | null)[]> {
  if (!reqs.length) return [];
  const contract = ({ hop, amountIn }: { hop: Hop; amountIn: bigint }) =>
    hop.venue === "v3"
      ? ({
          address: chain.v3.quoterV2,
          abi: v3QuoterAbi,
          functionName: "quoteExactInputSingle" as const,
          args: [
            { tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, amountIn, fee: hop.fee, sqrtPriceLimitX96: 0n },
          ] as const,
        } as const)
      : ({
          address: chain.v4.quoter,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle" as const,
          args: [
            { poolKey: hop.key, zeroForOne: hop.zeroForOne, exactAmount: amountIn, hookData: "0x" as Hex },
          ] as const,
        } as const);
  const CHUNK = 4;
  const groups: { hop: Hop; amountIn: bigint }[][] = [];
  for (let i = 0; i < reqs.length; i += CHUNK) groups.push(reqs.slice(i, i + CHUNK));
  const out = await Promise.all(
    groups.map(async (g) => {
      try {
        const res = await ctx.client.multicall({
          contracts: g.map(contract),
          allowFailure: true,
          blockNumber: ctx.blockNumber,
          batchSize: 0,
        });
        return res.map((r) => (r.status === "success" ? (r.result as readonly bigint[])[0]! : null));
      } catch {
        return g.map(() => null);
      }
    }),
  );
  return out.flat();
}

export async function hookChecks(ctx: EngineContext, hooks: Address[]): Promise<HookCheck[]> {
  return Promise.all(
    [...new Set(hooks.map(lc))].map(async (h) => {
      const value = await ctx.cache.get(`hookcode:${h}`, 120, async () => {
        const [code, impl] = await Promise.all([
          ctx.client.getCode({ address: h }).catch(() => undefined),
          ctx.client.getStorageAt({ address: h, slot: EIP1967_IMPL_SLOT }).catch(() => undefined),
        ]);
        return { codehash: codehashOf(code), proxy: !!impl && !/^0x0*$/.test(impl) };
      });
      const pin = ctx.registry.hookPin(h);
      const flags = decodeFlags(h);
      return {
        hook: getAddress(h) as Address,
        codehash: value.codehash,
        pinned: pin?.codehash ?? null,
        status: !value.codehash ? "no-code" : !pin ? "new" : pin.codehash === value.codehash ? "match" : "changed",
        flags: FLAGS.filter((f) => flags[f.key]).map((f) => f.key),
        proxy: value.proxy,
      } satisfies HookCheck;
    }),
  );
}

const hubsFor = (a: Address, b: Address): Address[] =>
  [USDG, NATIVE].filter(
    (h) => h !== a && h !== b && !(h === NATIVE && (a === WETH || b === WETH)) && !(isEth(h) && (isEth(a) || isEth(b))),
  );

/** Every route considered for a trade, best output first. */
export async function bestPlans(ctx: EngineContext, a: Address, b: Address, amountIn: bigint, includeHooked: boolean) {
  const direct = await candidates(ctx, a, b, includeHooked);
  const directOut = await quoteMany(
    ctx,
    direct.map((c) => ({ hop: c.hop, amountIn })),
  );
  const priced = direct
    .map((c, i) => ({ c, out: directOut[i] ?? null }))
    .sort((x, y) => ((y.out ?? -1n) > (x.out ?? -1n) ? 1 : -1));
  const plans: Plan[] = [];
  const ok = priced.filter((p) => p.out && p.out > 0n);
  const best = (pred: (c: Candidate) => boolean) => ok.find((p) => pred(p.c));
  for (const pick of [best(() => true), best((c) => !c.hooked)])
    if (pick)
      plans.push({
        kind: "single",
        legs: [{ amountIn, amountOut: pick.out!, hops: [pick.c.hop], cands: [pick.c] }],
        out: pick.out!,
      });

  // Two-way split between the two best direct pools (and the two best unhooked, for the baseline).
  type Priced = (typeof ok)[number];
  const splitPairs: [Priced, Priced][] = [];
  // The router can't unwrap part of a WETH balance, so WETH input never splits into a native-ETH pool.
  const splittable = ok.filter((p) => !(a === WETH && isEth(hopIn(p.c.hop))));
  if (splittable.length >= 2) splitPairs.push([splittable[0]!, splittable[1]!]);
  const unh = splittable.filter((p) => !p.c.hooked);
  if (unh.length >= 2 && (unh[0] !== splittable[0] || unh[1] !== splittable[1])) splitPairs.push([unh[0]!, unh[1]!]);
  const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const splitReqs = splitPairs.flatMap(([x, y]) =>
    steps.flatMap((s) => [
      { hop: x.c.hop, amountIn: (amountIn * BigInt(s)) / 10n },
      { hop: y.c.hop, amountIn: amountIn - (amountIn * BigInt(s)) / 10n },
    ]),
  );
  const splitOut = await quoteMany(ctx, splitReqs);
  splitPairs.forEach(([x, y], pi) => {
    let bestS: Plan | null = null;
    steps.forEach((_s, si) => {
      const i = pi * steps.length * 2 + si * 2;
      const o1 = splitOut[i];
      const o2 = splitOut[i + 1];
      if (!o1 || !o2) return;
      const a1 = splitReqs[i]!.amountIn;
      const plan: Plan = {
        kind: "split",
        out: o1 + o2,
        legs: [
          { amountIn: a1, amountOut: o1, hops: [x.c.hop], cands: [x.c] },
          { amountIn: amountIn - a1, amountOut: o2, hops: [y.c.hop], cands: [y.c] },
        ],
      };
      if (!bestS || plan.out > bestS.out) bestS = plan;
    });
    if (bestS) plans.push(bestS);
  });

  // Two-hop via USDG / ETH. Each hub's pools are kept for the "every venue" view of pairs with no direct pool.
  const hubViews: { hub: Address; first: CandidateView[]; second: CandidateView[] }[] = [];
  for (const h of hubsFor(a, b)) {
    const [c1, c2] = await Promise.all([candidates(ctx, a, h, includeHooked), candidates(ctx, h, b, includeHooked)]);
    if (!c1.length || !c2.length) continue;
    const o1 = await quoteMany(
      ctx,
      c1.map((c) => ({ hop: c.hop, amountIn })),
    );
    const p1 = c1
      .map((c, i) => ({ c, out: o1[i] ?? null }))
      .filter((p) => p.out && p.out > 0n)
      .sort((x, y) => (y.out! > x.out! ? 1 : -1));
    const firsts = [p1[0], p1.find((p) => !p.c.hooked)].filter((x, i, arr) => x && arr.indexOf(x) === i) as typeof p1;
    if (!firsts.length) continue;
    const reqs = firsts.flatMap((f) => c2.map((c) => ({ hop: c.hop, amountIn: f.out! })));
    const o2 = await quoteMany(ctx, reqs);
    const view = (c: Candidate, out: bigint | null | undefined): CandidateView => ({
      label: c.label,
      venue: c.venue,
      hooked: c.hooked,
      amountOut: out ? out.toString() : null,
    });
    const byOut = (x: CandidateView, y: CandidateView) =>
      BigInt(y.amountOut ?? -1) > BigInt(x.amountOut ?? -1) ? 1 : -1;
    hubViews.push({
      hub: h,
      first: c1.map((c, i) => view(c, o1[i])).sort(byOut),
      second: c2.map((c, i) => view(c, o2[i])).sort(byOut),
    });
    firsts.forEach((f, fi) => {
      c2.forEach((c, ci) => {
        const out = o2[fi * c2.length + ci];
        if (!out) return;
        plans.push({
          kind: "multi-hop",
          out,
          legs: [{ amountIn, amountOut: out, hops: [f.c.hop, c.hop], cands: [f.c, c] }],
        });
      });
    });
  }
  const candidatesView: CandidateView[] = priced.map((p) => ({
    label: p.c.label,
    venue: p.c.venue,
    hooked: p.c.hooked,
    amountOut: p.out?.toString() ?? null,
    ...(p.out ? {} : { error: "no quote (reverted or no liquidity)" }),
  }));
  return { plans: plans.sort((x, y) => (y.out > x.out ? 1 : -1)), candidates: candidatesView, hubs: hubViews };
}

/** Same route at 1/1000 size: the rate gap is price impact (fees are paid in both, so they cancel). */
async function probeOut(ctx: EngineContext, plan: Plan, amountIn: bigint): Promise<{ in: bigint; out: bigint } | null> {
  const probeIn = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
  let total = 0n;
  for (const leg of plan.legs) {
    let amt = (leg.amountIn * probeIn) / amountIn;
    if (amt === 0n) amt = 1n;
    for (const hop of leg.hops) {
      const [o] = await quoteMany(ctx, [{ hop, amountIn: amt }]);
      if (!o) return null;
      amt = o;
    }
    total += amt;
  }
  return { in: probeIn, out: total };
}

const intParam = (v: number | string | undefined, dflt: number) => (v === undefined || v === "" ? dflt : Number(v));

/** Validate quote parameters into raw values (throws ZhookError 400). */
export function parseLimits(q: Pick<QuoteParams, "slippageBps" | "feeBps" | "feeRecipient">) {
  const slippageBps = intParam(q.slippageBps, DEFAULT_SLIPPAGE_BPS);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS)
    throw new ZhookError(400, `slippageBps must be 1-${MAX_SLIPPAGE_BPS} (capped)`);
  const feeBps = intParam(q.feeBps, 0);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_INTEGRATOR_FEE_BPS)
    throw new ZhookError(400, `feeBps must be an integer 0-${MAX_INTEGRATOR_FEE_BPS} (max 0.5%)`);
  const feeRecipient =
    q.feeRecipient && /^0x[0-9a-fA-F]{40}$/.test(q.feeRecipient) ? (getAddress(q.feeRecipient) as Address) : null;
  if (feeBps > 0 && !feeRecipient) throw new ZhookError(400, "feeRecipient (address) is required when feeBps > 0");
  return { slippageBps, feeBps, feeRecipient };
}

export async function quoteRoute(ctx: EngineContext, q: QuoteParams): Promise<QuoteResponse> {
  if (!q.tokenIn || !q.tokenOut)
    throw new ZhookError(400, "tokenIn and tokenOut are required (address, or 'ETH' for native ETH)");
  const [tIn, tOut] = await Promise.all([tokenInfo(ctx, q.tokenIn), tokenInfo(ctx, q.tokenOut)]);
  const a = lc(tIn.address);
  const b = lc(tOut.address);
  if (a === b || (isEth(a) && b === WETH) || (a === WETH && isEth(b)))
    throw new ZhookError(400, "tokenIn and tokenOut are the same asset (wrap/unwrap is not a swap)");
  if (typeof q.amount !== "string" || !/^\d+(\.\d+)?$/.test(q.amount))
    throw new ZhookError(400, "amount must be a positive decimal in tokenIn units");
  let amountIn: bigint;
  try {
    amountIn = parseUnits(q.amount, tIn.decimals);
  } catch {
    throw new ZhookError(400, "amount has too many decimals");
  }
  if (amountIn <= 0n || amountIn >= 2n ** 128n) throw new ZhookError(400, "amount out of range");
  const { slippageBps, feeBps, feeRecipient } = parseLimits(q);
  const from = q.from && /^0x[0-9a-fA-F]{40}$/.test(q.from) ? (getAddress(q.from) as Address) : null;
  if (q.from && !from) throw new ZhookError(400, "from must be an address");
  const includeHooked = q.hooks !== false;
  let minAmountOutRaw: bigint | null = null;
  if (q.minAmountOut !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(q.minAmountOut)) throw new ZhookError(400, "minAmountOut must be a decimal");
    minAmountOutRaw = parseUnits(q.minAmountOut, tOut.decimals);
  }

  const [pins, block, found] = await Promise.all([
    ctx.cache.get("pins", 300, () => checkPins(ctx.client)),
    ctx.blockNumber ?? ctx.client.getBlockNumber(),
    bestPlans(ctx, a, b, amountIn, includeHooked),
  ]);
  const pinsOk = pins.every((p) => p.ok);
  const warnings: QuoteResponse["warnings"] = [];
  const best = found.plans[0];
  if (!best)
    throw new ZhookError(
      404,
      `No Uniswap v3/v4 route found for ${tIn.symbol} → ${tOut.symbol} on Robinhood Chain (direct or via USDG / ETH).`,
    );
  const unhooked = found.plans.find((p) => p.legs.every((l) => l.cands.every((cd) => !cd.hooked)));

  const { afterFee, minOut } = minOutFor(best.out, feeBps, slippageBps);
  const probe = await probeOut(ctx, best, amountIn).catch(() => null);
  let impact: number | null = null;
  if (probe && probe.out > 0n) {
    const rate = Number(best.out) / Number(amountIn);
    const spot = Number(probe.out) / Number(probe.in);
    impact = spot > 0 ? Math.max(0, (1 - rate / spot) * 100) : null;
  }
  if (impact !== null && impact > 10)
    warnings.push({
      level: "high",
      message: `Price impact ${impact.toFixed(2)}%: this trade moves the pool a lot. Consider a smaller size.`,
    });
  else if (impact !== null && impact > 2)
    warnings.push({ level: "medium", message: `Price impact ${impact.toFixed(2)}%.` });
  if (!pinsOk)
    warnings.unshift({
      level: "high",
      message:
        "A pinned contract's code does not match its recorded hash: execution is blocked until this is reviewed.",
    });

  const hookAddrs = best.legs.flatMap((l) =>
    l.hops.flatMap((h) => (h.venue === "v4" && lc(h.key.hooks) !== NATIVE ? [h.key.hooks] : [])),
  );
  const hooks = await hookChecks(ctx, hookAddrs);
  for (const h of hooks) {
    if (h.status === "changed")
      warnings.push({
        level: "high",
        message: `Hook ${h.hook} has different code than when it was mapped: review before trading.`,
      });
    if (h.status === "new")
      warnings.push({
        level: "medium",
        message: `Hook ${h.hook} has no recorded codehash in the pool list; its code is not pinned.`,
      });
    if (h.proxy)
      warnings.push({
        level: "medium",
        message: `Hook ${h.hook} is an upgradeable proxy: its logic can change after this quote.`,
      });
    if (h.flags.includes("beforeSwapReturnDelta"))
      warnings.push({
        level: "info",
        message: `Hook ${h.hook.slice(0, 10)}… can rewrite swap amounts (beforeSwapReturnDelta). The quote runs it as it is at this block; the minimum received still protects you.`,
      });
  }
  if (unhooked && unhooked.out < best.out && unhooked !== best) {
    const gain = (Number(best.out - unhooked.out) / Number(unhooked.out)) * 100;
    warnings.push({ level: "info", message: `Hooked venues beat the best hook-free route by ${gain.toFixed(3)}%.` });
  }

  // Hard limits: any violation withholds the calldata.
  const blocked: string[] = [];
  if (!pinsOk)
    blocked.push("Pinned-contract check failed: a router, quoter, pool manager or token contract changed code.");
  if (q.pinnedHooksOnly && hooks.some((h) => h.status !== "match"))
    blocked.push("Route uses a hook whose code is not pinned or has changed.");
  if (q.maxPriceImpactPct !== undefined && (impact === null || impact > q.maxPriceImpactPct))
    blocked.push(
      impact === null
        ? "Price impact could not be measured."
        : `Price impact ${impact.toFixed(2)}% is above the ${q.maxPriceImpactPct}% limit.`,
    );
  if (minAmountOutRaw !== null && minOut < minAmountOutRaw)
    blocked.push(`Guaranteed minimum ${formatUnits(minOut, tOut.decimals)} is below the required ${q.minAmountOut}.`);

  let tx: SwapTx | null = null;
  let txNote: string | null = null;
  let simulation: Simulation | null = null;
  const deadline = Math.floor(ctx.now() / 1000) + (q.deadlineSeconds ?? 20 * 60);
  if (blocked.length) txNote = `Calldata withheld: ${blocked.join(" ")}`;
  else {
    try {
      const built = buildExecute({
        tokenIn: tIn.address,
        tokenOut: tOut.address,
        amountIn,
        legs: best.legs.map((l) => ({ amountIn: l.amountIn, hops: l.hops })),
        minOut,
        weth: chain.weth,
        feeBps,
        feeRecipient: feeRecipient ?? undefined,
        deadline: BigInt(deadline),
      });
      tx = {
        to: chain.universalRouter,
        data: built.data,
        value: built.value.toString(),
        commands: built.commands,
        deadline,
      };
      if (from) {
        simulation = await simulateTx(ctx.client, { from, to: tx.to, data: tx.data, value: built.value });
        if (!simulation.ok) txNote = `Simulation from ${from} reverted: ${simulation.error}`;
      }
    } catch (e) {
      txNote = `Calldata not built: ${(e as Error).message}`;
    }
  }

  return {
    chainId: chain.id,
    block: Number(block),
    tokenIn: tIn,
    tokenOut: tOut,
    amountIn: q.amount,
    amountInRaw: amountIn.toString(),
    amountOut: formatUnits(best.out, tOut.decimals),
    amountOutRaw: best.out.toString(),
    amountOutAfterFee: formatUnits(afterFee, tOut.decimals),
    minOut: formatUnits(minOut, tOut.decimals),
    minOutRaw: minOut.toString(),
    slippageBps,
    feeBps,
    feeRecipient,
    priceImpactPct: impact,
    kind: best.kind,
    legs: best.legs.map((l) => ({
      shareBps: Number((l.amountIn * 10_000n) / amountIn),
      amountIn: l.amountIn.toString(),
      amountOut: l.amountOut.toString(),
      hops: l.hops,
    })),
    candidates: found.candidates,
    hubCandidates: found.hubs.map((h) => ({
      hub: h.hub,
      symbol: h.hub === USDG ? "USDG" : "ETH",
      decimals: h.hub === USDG ? 6 : 18,
      first: h.first,
      second: h.second,
    })),
    bestUnhookedOut: unhooked ? formatUnits(unhooked.out, tOut.decimals) : null,
    gasEstimate: simulation?.gasEstimate ?? null,
    simulation,
    pins,
    pinsOk,
    hooks,
    warnings,
    blocked,
    tx,
    txNote,
    approval: isEth(a) ? null : { token: tIn.address, spender: chain.universalRouter, permit2: chain.permit2 },
  };
}

export type { PoolKey };
