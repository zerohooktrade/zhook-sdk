import { describe, expect, it } from "vitest";
import {
  buildExecute,
  NATIVE,
  PoolRegistry,
  quoteRoute,
  RHC,
  TtlCache,
  ZhookError,
  type EngineContext,
  type PoolKey,
  type QuoteParams,
} from "../src/index.js";
import { MOCK_CODEHASH, mockClient, okPins, type MockCurve } from "./mock-client.js";

const TKA = "0x1000000000000000000000000000000000000001";
const TKB = "0x2000000000000000000000000000000000000002";
const TKC = "0x3000000000000000000000000000000000000003";
const USDG = RHC.usdg.toLowerCase();
const HOOK = "0x00000000000000000000000000000000000000c8"; // beforeSwap | afterSwap | beforeSwapReturnDelta
const E18 = 10n ** 18n;

const curve = (num: bigint, den: bigint, depth: bigint): MockCurve => ({
  num0: num,
  den0: den,
  num1: den,
  den1: num,
  depth,
});
const key = (a: string, b: string, fee: number, hooks: string = NATIVE): PoolKey => {
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return {
    currency0: c0 as `0x${string}`,
    currency1: c1 as `0x${string}`,
    fee,
    tickSpacing: 60,
    hooks: hooks as `0x${string}`,
  };
};

const plainAB = key(TKA, TKB, 3000);
const hookedAB = key(TKA, TKB, 3000, HOOK);
const usdgC = key(USDG, TKC, 500);

function setup(
  opts: Parameters<typeof mockClient>[0],
  pins = okPins(),
  hookPins: Record<string, [string | null, number]> = {},
) {
  const client = mockClient(opts);
  const registry = new PoolRegistry({
    includeDefaults: false,
    pools: (opts.v4 ?? []).map((p) => ({ key: p.key, swaps: 10 })),
    tokens: { [TKA]: ["TKA", 18], [TKB]: ["TKB", 18], [TKC]: ["TKC", 18] },
    hookPins,
  });
  const cache = new TtlCache();
  void cache.get("pins", 300, async () => pins);
  const ctx: EngineContext = { client, registry, cache, now: () => 1_700_000_000_000 };
  return { ctx, client };
}

const deep = 10n ** 40n;
const base: QuoteParams = { tokenIn: TKA, tokenOut: TKB, amount: "1" };

describe("quoteRoute (mocked chain)", () => {
  it("picks the best venue across v3, v4 and hooked v4", async () => {
    const { ctx } = setup(
      {
        v3: [{ a: TKA, b: TKB, fee: 500, curve: curve(200n, 100n, deep) }],
        v4: [
          { key: plainAB, curve: curve(201n, 100n, deep) },
          { key: hookedAB, curve: curve(205n, 100n, deep) },
        ],
      },
      okPins(),
      { [HOOK]: [MOCK_CODEHASH, 2] },
    );
    const q = await quoteRoute(ctx, base);
    expect(q.kind).toBe("single");
    expect(q.amountOutRaw).toBe(2_050_000_000_000_000_000n.toString());
    expect(q.legs[0]!.hops[0]!.venue).toBe("v4");
    expect(q.candidates.map((c) => c.label)).toEqual([
      expect.stringContaining("hook 0x0000…00c8"),
      "Uniswap v4 · 0.3%",
      "Uniswap v3 · 0.05%",
    ]);
    expect(q.bestUnhookedOut).toBe("2.01");
    expect(q.hooks).toEqual([
      expect.objectContaining({ status: "match", flags: ["beforeSwap", "afterSwap", "beforeSwapReturnDelta"] }),
    ]);
    expect(q.warnings.some((w) => w.message.includes("beforeSwapReturnDelta"))).toBe(true);
    expect(q.warnings.some((w) => w.message.includes("Hooked venues beat"))).toBe(true);
    expect(q.blocked).toEqual([]);
    expect(q.tx?.to).toBe(RHC.universalRouter);
    expect(q.tx?.commands).toEqual(["PERMIT2_TRANSFER_FROM", "V4_SWAP", "SWEEP"]);
    expect(q.approval).toEqual({ token: expect.any(String), spender: RHC.universalRouter, permit2: RHC.permit2 });
  });

  it("returns calldata identical to buildExecute for the returned legs", async () => {
    const { ctx } = setup({ v4: [{ key: plainAB, curve: curve(3n, 1n, deep) }] });
    const q = await quoteRoute(ctx, { ...base, slippageBps: 100, feeBps: 20, feeRecipient: TKC });
    const rebuilt = buildExecute({
      tokenIn: q.tokenIn.address,
      tokenOut: q.tokenOut.address,
      amountIn: BigInt(q.amountInRaw),
      legs: q.legs.map((l) => ({ amountIn: BigInt(l.amountIn), hops: l.hops })),
      minOut: BigInt(q.minOutRaw),
      weth: RHC.weth,
      feeBps: q.feeBps,
      feeRecipient: q.feeRecipient!,
      deadline: BigInt(q.tx!.deadline),
    });
    expect(q.tx!.data).toBe(rebuilt.data);
    expect(q.tx!.deadline).toBe(1_700_000_000 + 1200);
    // 3e18 out, 0.2 % fee, 1 % slippage
    expect(q.minOutRaw).toBe(((((3n * E18 * 9980n) / 10000n) * 9900n) / 10000n).toString());
  });

  it("splits when two shallow pools beat one", async () => {
    const shallow = 10n ** 19n;
    const { ctx } = setup({
      v3: [{ a: TKA, b: TKB, fee: 3000, curve: curve(2n, 1n, shallow) }],
      v4: [{ key: plainAB, curve: curve(2n, 1n, shallow) }],
    });
    const q = await quoteRoute(ctx, { ...base, amount: "4" });
    expect(q.kind).toBe("split");
    expect(q.legs).toHaveLength(2);
    expect(q.legs.reduce((s, l) => s + l.shareBps, 0)).toBe(10_000);
    expect([...q.tx!.commands].sort()).toEqual(["PERMIT2_TRANSFER_FROM", "SWEEP", "V3_SWAP_EXACT_IN", "V4_SWAP"]);
    expect(q.priceImpactPct).toBeGreaterThan(0);
  });

  it("routes two hops through USDG when there is no direct pool", async () => {
    const { ctx } = setup({
      v3: [
        { a: TKA, b: USDG, fee: 500, curve: { num0: 1n, den0: 10n ** 12n, num1: 10n ** 12n, den1: 1n, depth: deep } },
      ],
      v4: [{ key: usdgC, curve: { num0: 1n, den0: 10n ** 12n, num1: 10n ** 12n, den1: 1n, depth: deep } }],
    });
    const q = await quoteRoute(ctx, { tokenIn: TKA, tokenOut: TKC, amount: "1" });
    expect(q.kind).toBe("multi-hop");
    expect(q.legs[0]!.hops.map((h) => h.venue)).toEqual(["v3", "v4"]);
    expect(q.hubCandidates[0]!.symbol).toBe("USDG");
    expect(q.tx?.commands).toEqual(["PERMIT2_TRANSFER_FROM", "V3_SWAP_EXACT_IN", "V4_SWAP", "SWEEP"]);
  });

  it("skips hooked pools when hooks is false", async () => {
    const { ctx } = setup({
      v4: [
        { key: plainAB, curve: curve(2n, 1n, deep) },
        { key: hookedAB, curve: curve(3n, 1n, deep) },
      ],
    });
    const q = await quoteRoute(ctx, { ...base, hooks: false });
    expect(q.candidates).toHaveLength(1);
    expect(q.hooks).toEqual([]);
    expect(q.amountOut).toBe("2");
  });

  it("simulates from the signer when from is given", async () => {
    const { ctx } = setup({ v4: [{ key: plainAB, curve: curve(2n, 1n, deep) }], gas: 321_000n });
    const q = await quoteRoute(ctx, { ...base, from: TKC });
    expect(q.simulation).toEqual({ ok: true, gasEstimate: "321000", error: null, overridden: false });
    expect(q.gasEstimate).toBe("321000");
    expect(q.txNote).toBeNull();
  });

  it("reports a reverting simulation without throwing", async () => {
    const { ctx } = setup({ v4: [{ key: plainAB, curve: curve(2n, 1n, deep) }], revert: "TRANSFER_FROM_FAILED" });
    const q = await quoteRoute(ctx, { ...base, from: TKC });
    expect(q.simulation?.ok).toBe(false);
    expect(q.txNote).toContain("TRANSFER_FROM_FAILED");
    expect(q.tx).not.toBeNull();
  });
});

describe("hard limits", () => {
  const pools = { v4: [{ key: plainAB, curve: curve(2n, 1n, 10n ** 19n) }] };

  it("withholds calldata when a pinned contract changed", async () => {
    const pins = okPins();
    pins[0] = { ...pins[0]!, ok: false, actual: "0xdead" };
    const { ctx } = setup(pools, pins);
    const q = await quoteRoute(ctx, base);
    expect(q.pinsOk).toBe(false);
    expect(q.tx).toBeNull();
    expect(q.blocked[0]).toContain("Pinned-contract");
  });

  it("withholds calldata above the price-impact limit", async () => {
    const { ctx } = setup(pools);
    const q = await quoteRoute(ctx, { ...base, amount: "2", maxPriceImpactPct: 1 });
    expect(q.priceImpactPct).toBeGreaterThan(1);
    expect(q.tx).toBeNull();
    expect(q.txNote).toContain("above the 1% limit");
  });

  it("withholds calldata below the required minimum", async () => {
    const { ctx } = setup(pools);
    const q = await quoteRoute(ctx, { ...base, minAmountOut: "5" });
    expect(q.tx).toBeNull();
    expect(q.blocked[0]).toContain("below the required 5");
  });

  it("withholds calldata through an unpinned hook when pinnedHooksOnly", async () => {
    const { ctx } = setup({ v4: [{ key: hookedAB, curve: curve(2n, 1n, deep) }] });
    const q = await quoteRoute(ctx, { ...base, pinnedHooksOnly: true });
    expect(q.hooks[0]!.status).toBe("new");
    expect(q.tx).toBeNull();
    const loose = await quoteRoute(ctx, base);
    expect(loose.tx).not.toBeNull();
  });

  it.each([
    [{ slippageBps: 301 }, "slippageBps must be 1-300"],
    [{ slippageBps: 0 }, "slippageBps must be 1-300"],
    [{ feeBps: 51, feeRecipient: TKC }, "feeBps must be an integer 0-50"],
    [{ feeBps: 10 }, "feeRecipient (address) is required"],
    [{ amount: "-1" }, "amount must be a positive decimal"],
    [{ tokenOut: TKA }, "same asset"],
    [{ tokenIn: "ETH", tokenOut: RHC.weth }, "same asset"],
    [{ tokenIn: "nope" }, "Not a token address"],
    [{ from: "0x12" }, "from must be an address"],
  ] as [Partial<QuoteParams>, string][])("rejects %o", async (over, msg) => {
    const { ctx } = setup(pools);
    const err = await quoteRoute(ctx, { ...base, ...over }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZhookError);
    expect((err as ZhookError).status).toBe(400);
    expect((err as Error).message).toContain(msg);
  });

  it("answers 404 when no route exists", async () => {
    const { ctx } = setup({});
    const err = await quoteRoute(ctx, base).catch((e: unknown) => e);
    expect((err as ZhookError).status).toBe(404);
  });
});
