import type { Hop } from "../src/index.js";

type Json = Record<string, unknown>;

/** Turn a JSON hop back into a typed Hop. */
export function hopFromJson(h: Json): Hop {
  if (h.venue === "v3")
    return {
      venue: "v3",
      pool: h.pool as `0x${string}`,
      tokenIn: h.tokenIn as `0x${string}`,
      tokenOut: h.tokenOut as `0x${string}`,
      fee: Number(h.fee),
    };
  const k = h.key as Json;
  return {
    venue: "v4",
    poolId: h.poolId as `0x${string}`,
    zeroForOne: Boolean(h.zeroForOne),
    key: {
      currency0: k.currency0 as `0x${string}`,
      currency1: k.currency1 as `0x${string}`,
      fee: Number(k.fee),
      tickSpacing: Number(k.tickSpacing),
      hooks: k.hooks as `0x${string}`,
    },
  };
}
