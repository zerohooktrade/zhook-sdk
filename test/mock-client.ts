/**
 * A deterministic in-memory stand-in for a viem PublicClient: v3 pools exist only where configured and every quoter
 * answers from a constant rate per pool minus a quadratic impact term, so routing can be tested without a network.
 */
import { keccak256, type PublicClient } from "viem";
import { PINS, poolIdOf, RHC, USDG_IMPL, type PinCheck, type PoolKey } from "../src/index.js";

export interface MockCurve {
  /** token0 → token1: out = in × num / den, minus in² / depth. */
  num0: bigint;
  den0: bigint;
  /** token1 → token0. */
  num1: bigint;
  den1: bigint;
  depth: bigint;
}

type Contract = { address: string; functionName: string; args: readonly unknown[] };
const lc = (s: string) => s.toLowerCase();

export const MOCK_CODE = "0x6000" as const;
export const MOCK_CODEHASH = keccak256(MOCK_CODE);

export function mockClient(opts: {
  v3?: { a: string; b: string; fee: number; curve: MockCurve }[];
  v4?: { key: PoolKey; curve: MockCurve }[];
  head?: bigint;
  gas?: bigint;
  revert?: string;
}) {
  const v3Key = (a: string, b: string, fee: number) => `${[lc(a), lc(b)].sort().join(":")}:${fee}`;
  const v3 = new Map((opts.v3 ?? []).map((p) => [v3Key(p.a, p.b, p.fee), p.curve]));
  const v4 = new Map((opts.v4 ?? []).map((p) => [poolIdOf(p.key), p.curve]));
  const calls: string[] = [];
  const out = (c: MockCurve, zeroForOne: boolean, amountIn: bigint) => {
    const gross = zeroForOne ? (amountIn * c.num0) / c.den0 : (amountIn * c.num1) / c.den1;
    const impact = (gross * amountIn) / c.depth;
    if (gross <= impact) throw new Error("no liquidity");
    return gross - impact;
  };
  const answer = (c: Contract): unknown => {
    calls.push(c.functionName);
    if (c.functionName === "getPool") {
      const [a, b, fee] = c.args as [string, string, number];
      return v3.has(v3Key(a, b, fee))
        ? `0x${fee.toString(16).padStart(40, "a")}`
        : "0x0000000000000000000000000000000000000000";
    }
    if (c.functionName === "quoteExactInputSingle" && lc(c.address) === RHC.v3.quoterV2) {
      const [q] = c.args as [{ tokenIn: string; tokenOut: string; amountIn: bigint; fee: number }];
      const curve = v3.get(v3Key(q.tokenIn, q.tokenOut, q.fee));
      if (!curve) throw new Error("no pool");
      return [out(curve, lc(q.tokenIn) < lc(q.tokenOut), q.amountIn), 0n, 0, 0n];
    }
    if (c.functionName === "quoteExactInputSingle" && lc(c.address) === RHC.v4.quoter) {
      const [q] = c.args as [{ poolKey: PoolKey; zeroForOne: boolean; exactAmount: bigint }];
      const curve = v4.get(poolIdOf(q.poolKey));
      if (!curve) throw new Error("no pool");
      return [out(curve, q.zeroForOne, q.exactAmount), 0n];
    }
    throw new Error(`unexpected call ${c.functionName}`);
  };
  const client = {
    calls,
    async getBlockNumber() {
      return opts.head ?? 100n;
    },
    async multicall({ contracts }: { contracts: Contract[] }) {
      return contracts.map((c) => {
        try {
          return { status: "success", result: answer(c) };
        } catch (error) {
          return { status: "failure", error };
        }
      });
    },
    async getCode() {
      return MOCK_CODE;
    },
    async getStorageAt() {
      return "0x" + "0".repeat(64);
    },
    async readContract() {
      throw new Error("not mocked");
    },
    async call() {
      if (opts.revert) throw new Error(opts.revert);
      return { data: "0x" };
    },
    async estimateGas() {
      if (opts.revert) throw new Error(opts.revert);
      return opts.gas ?? 210_000n;
    },
  };
  return client as unknown as PublicClient & { calls: string[] };
}

export const okPins = (): PinCheck[] => [
  ...PINS.map((p) => ({ name: p.name, address: p.address, ok: true, expected: p.codehash, actual: p.codehash })),
  { name: "USDG implementation slot", address: RHC.usdg, ok: true, expected: USDG_IMPL, actual: USDG_IMPL },
];
