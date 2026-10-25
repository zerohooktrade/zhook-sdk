/**
 * Live checks against Robinhood Chain. Skipped unless RPC_URL is set, for example:
 *   RPC_URL=https://robinhood-rpc.publicnode.com pnpm test:live
 */
import { describe, expect, it } from "vitest";
import { createZhook, NATIVE, RHC } from "../src/index.js";

const RPC_URL = process.env.RPC_URL;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const DRY_RUN_WALLET = "0x000000000000000000000000000000000000dEaD";

describe.skipIf(!RPC_URL)("live: Robinhood Chain", () => {
  const z = createZhook({ rpcUrls: RPC_URL ? [RPC_URL] : [] });

  it("every pinned contract still has its recorded code", async () => {
    const pins = await z.checkPins();
    expect(pins.filter((p) => !p.ok)).toEqual([]);
  });

  it("quotes ETH → USDG with calldata that simulates from a funded dry-run wallet", async () => {
    const q = await z.quote({ tokenIn: "ETH", tokenOut: RHC.usdg, amount: "0.01" });
    expect(q.pinsOk).toBe(true);
    expect(BigInt(q.amountOutRaw)).toBeGreaterThan(0n);
    expect(q.tx).not.toBeNull();
    const sim = await z.simulate({
      from: DRY_RUN_WALLET,
      to: q.tx!.to,
      data: q.tx!.data,
      value: BigInt(q.tx!.value),
      fundEth: true,
    });
    expect(sim.error).toBeNull();
    expect(sim.ok).toBe(true);
  });

  it("quotes a Stock Token against USDG", async () => {
    const q = await z.quote({ tokenIn: RHC.usdg, tokenOut: NVDA, amount: "25", maxPriceImpactPct: 5 });
    expect(q.tokenOut.decimals).toBe(18);
    expect(q.approval?.permit2).toBe(RHC.permit2);
  });

  it("prices ETH in USD", async () => {
    const p = await z.price(NATIVE);
    expect(p.priceUsd).toBeGreaterThan(100);
  });

  it("verifies Robinhood Stock Tokens by exact proxy code", async () => {
    const s = await z.stockTokens();
    expect(s.tokens.length).toBeGreaterThan(50);
    expect(s.tokens.some((t) => t.address.toLowerCase() === NVDA.toLowerCase())).toBe(true);
    expect(await z.isStockToken(RHC.usdg)).toBe(false);
  });

  it("builds a passport for the most-traded hook of the default set", async () => {
    const hook = z.registry.hooks()[0]!.hook;
    const p = await z.hookPassport(hook);
    expect(p.code.exists).toBe(true);
    expect(p.risk.score).toBeGreaterThanOrEqual(0);
  });

  it("discovers pools from recent Initialize logs", async () => {
    const r = await z.discoverPools({ blocks: 3000 });
    expect(r.toBlock).toBeGreaterThan(r.fromBlock);
    for (const p of r.pools) expect(z.registry.get(p.id)).not.toBeNull();
  });
});
