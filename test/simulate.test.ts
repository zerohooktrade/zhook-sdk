import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, maxUint160, maxUint256 } from "viem";
import { approvalTxs, erc20Abi, permit2Abi, RHC, simulateTx } from "../src/index.js";
import { mockClient } from "./mock-client.js";

const TOKEN = "0x1000000000000000000000000000000000000001" as const;
const FROM = "0x3000000000000000000000000000000000000003" as const;

describe("approvalTxs", () => {
  it("builds ERC-20 → Permit2 and Permit2 → Universal Router approvals", () => {
    const [a, b] = approvalTxs(TOKEN, { now: 1_700_000_000_000 });
    expect(a!.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: erc20Abi, data: a!.data }).args).toEqual([RHC.permit2, maxUint256]);
    expect(b!.to).toBe(RHC.permit2);
    expect(decodeFunctionData({ abi: permit2Abi, data: b!.data }).args).toEqual([
      TOKEN,
      getAddress(RHC.universalRouter),
      maxUint160,
      1_700_000_000 + 30 * 86_400,
    ]);
  });

  it("takes an exact amount and expiration", () => {
    const [a, b] = approvalTxs(TOKEN, { amount: 5n, expiration: 99 });
    expect(decodeFunctionData({ abi: erc20Abi, data: a!.data }).args).toEqual([getAddress(RHC.permit2), 5n]);
    expect(decodeFunctionData({ abi: permit2Abi, data: b!.data }).args).toEqual([
      TOKEN,
      getAddress(RHC.universalRouter),
      5n,
      99,
    ]);
  });
});

describe("simulateTx", () => {
  it("passes with a gas estimate", async () => {
    const s = await simulateTx(mockClient({ gas: 99_000n }), {
      from: FROM,
      to: RHC.universalRouter,
      data: "0x12",
      fundEth: true,
    });
    expect(s).toEqual({ ok: true, gasEstimate: "99000", error: null, overridden: true });
  });

  it("returns the revert reason instead of throwing", async () => {
    const s = await simulateTx(mockClient({ revert: "V4TooLittleReceived()\nmore" }), {
      from: FROM,
      to: RHC.universalRouter,
      data: "0x12",
    });
    expect(s).toEqual({ ok: false, gasEstimate: null, error: "V4TooLittleReceived()", overridden: false });
  });
});
