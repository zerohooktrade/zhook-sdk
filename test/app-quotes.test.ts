import { describe, expect, it } from "vitest";
import { buildExecute, minOutFor, poolIdOf, RHC } from "../src/index.js";
import captured from "./vectors/app-quotes.json" with { type: "json" };
import { hopFromJson } from "./helpers.js";

describe("live app quotes: the SDK rebuilds the app's calldata byte for byte", () => {
  it("has captured quotes", () => {
    expect(captured.quotes.length).toBeGreaterThanOrEqual(5);
  });

  for (const q of captured.quotes) {
    const name = `${q.request.tokenIn.slice(0, 8)} → ${q.request.tokenOut.slice(0, 8)} ${q.request.amount} (${q.kind}, ${q.tx.commands.join(" ")})`;
    it(name, () => {
      const legs = q.legs.map((l) => ({
        amountIn: BigInt(l.amountIn),
        hops: (l.hops as Record<string, unknown>[]).map(hopFromJson),
      }));
      for (const l of legs)
        for (const h of l.hops) if (h.venue === "v4") expect(poolIdOf(h.key)).toBe(h.poolId.toLowerCase());
      const r = buildExecute({
        tokenIn: q.tokenIn as `0x${string}`,
        tokenOut: q.tokenOut as `0x${string}`,
        amountIn: BigInt(q.amountInRaw),
        legs,
        minOut: BigInt(q.minOutRaw),
        weth: RHC.weth,
        feeBps: q.feeBps,
        ...(q.feeRecipient ? { feeRecipient: q.feeRecipient as `0x${string}` } : {}),
        deadline: BigInt(q.tx.deadline),
      });
      expect(minOutFor(BigInt(q.amountOutRaw), q.feeBps, q.slippageBps).minOut.toString()).toBe(q.minOutRaw);
      expect(q.tx.to.toLowerCase()).toBe(RHC.universalRouter);
      expect(r.data).toBe(q.tx.data);
      expect(r.value.toString()).toBe(q.tx.value);
      expect(r.commands).toEqual(q.tx.commands);
    });
  }
});
