import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { buildExecute, minOutFor, RHC, universalRouterAbi, type BuildParams } from "../src/index.js";
import vectors from "./vectors/encoder.json" with { type: "json" };
import { hopFromJson } from "./helpers.js";

type P = (typeof vectors.vectors)[number]["params"];

function params(p: P): BuildParams {
  const q = p as unknown as Record<string, unknown>;
  return {
    tokenIn: q.tokenIn as `0x${string}`,
    tokenOut: q.tokenOut as `0x${string}`,
    amountIn: BigInt(q.amountIn as string),
    legs: (q.legs as { amountIn: string; hops: Record<string, unknown>[] }[]).map((l) => ({
      amountIn: BigInt(l.amountIn),
      hops: l.hops.map(hopFromJson),
    })),
    minOut: BigInt(q.minOut as string),
    weth: q.weth as `0x${string}`,
    deadline: BigInt(q.deadline as string),
    ...(q.feeBps !== undefined ? { feeBps: Number(q.feeBps) } : {}),
    ...(q.feeRecipient !== undefined ? { feeRecipient: q.feeRecipient as `0x${string}` } : {}),
  };
}

describe("golden vectors: calldata is byte-identical to the Zerohook app encoder", () => {
  it("has vectors", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(15);
  });

  for (const v of vectors.vectors) {
    it(v.name, () => {
      const r = buildExecute(params(v.params));
      expect(r.data).toBe(v.expected.data);
      expect(r.value.toString()).toBe(v.expected.value);
      expect(r.commands).toEqual(v.expected.commands);
    });
  }

  for (const e of vectors.errors) {
    it(`rejects: ${e.name}`, () => {
      expect(e.error).toBeTruthy();
      expect(() => buildExecute(params(e.params as P))).toThrow(e.error!);
    });
  }
});

describe("minOutFor", () => {
  for (const m of vectors.minOut) {
    it(`${m.amountOut} at ${m.feeBps} bps fee, ${m.slippageBps} bps slippage`, () => {
      const r = minOutFor(BigInt(m.amountOut), m.feeBps as number, m.slippageBps as number);
      expect(r.fee.toString()).toBe(m.fee);
      expect(r.afterFee.toString()).toBe(m.afterFee);
      expect(r.minOut.toString()).toBe(m.minOut);
    });
  }
});

describe("calldata shape", () => {
  it("decodes as execute(commands, inputs, deadline) and ends with SWEEP to msg.sender", () => {
    const v = vectors.vectors.find((x) => x.name.startsWith("integrator fee (PAY_PORTION)"))!;
    const { functionName, args } = decodeFunctionData({
      abi: universalRouterAbi,
      data: v.expected.data as `0x${string}`,
    });
    expect(functionName).toBe("execute");
    const [commands, inputs, deadline] = args;
    expect(commands).toBe("0x100604");
    expect(inputs).toHaveLength(3);
    expect(deadline).toBe(1_767_225_600n);
    // SWEEP(token, MSG_SENDER = 0x…01, minOut)
    expect(inputs[2]!.slice(2 + 64 + 24, 2 + 128)).toBe("0000000000000000000000000000000000000001");
  });

  it("encodes the Robinhood Chain v4 minHopPriceX36 field", () => {
    const v = vectors.vectors.find((x) => x.name === "v4 single native ETH in")!;
    const r = buildExecute(params(v.params));
    // ExactInputSingleParams has 6 fields on this router: the encoded params are longer than the 5-field form.
    expect(r.data.length).toBeGreaterThan(1000);
    expect(r.data).toBe(v.expected.data);
  });

  it("uses msg.value only for native ETH input", () => {
    const eth = vectors.vectors.find((x) => x.name === "v4 single native ETH in")!;
    const erc = vectors.vectors.find((x) => x.name === "v4 single native ETH out")!;
    expect(buildExecute(params(eth.params)).value).toBe(BigInt(eth.params.amountIn));
    expect(buildExecute(params(erc.params)).value).toBe(0n);
    expect(eth.params.weth.toLowerCase()).toBe(RHC.weth);
  });
});
