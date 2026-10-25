import { describe, expect, it } from "vitest";
import {
  ALL_HOOK_MASK,
  buildPassport,
  decodeFlags,
  evaluatePassport,
  invalidDeltaPairs,
  maskHex,
  maskOf,
  minimalProxyTarget,
  PoolRegistry,
  scanBytecode,
  TtlCache,
  type PassportFacts,
} from "../src/index.js";
import { mockClient } from "./mock-client.js";

describe("hook permission flags", () => {
  it("reads the lowest 14 bits of the address", () => {
    const f = decodeFlags("0x00000000000000000000000000000000000000c8");
    expect(f.beforeSwap).toBe(true);
    expect(f.afterSwap).toBe(true);
    expect(f.beforeSwapReturnDelta).toBe(true);
    expect(f.beforeInitialize).toBe(false);
    expect(maskHex(maskOf(["beforeSwap", "afterSwap", "beforeSwapReturnDelta"]))).toBe("0x00c8");
    expect(ALL_HOOK_MASK).toBe(0x3fff);
  });

  it("flags a ReturnDelta bit without its base callback as invalid", () => {
    expect(invalidDeltaPairs(decodeFlags("0x0000000000000000000000000000000000000008")).map((f) => f.key)).toEqual([
      "beforeSwapReturnDelta",
    ]);
  });
});

describe("bytecode scan", () => {
  it("finds PUSH4 selectors and DELEGATECALL, skipping push data", () => {
    // PUSH4 8456cb59 (pause()), DELEGATECALL, PUSH1 ff (data, not SELFDESTRUCT)
    const r = scanBytecode("0x638456cb59f460ff");
    expect(r.functions).toEqual([{ signature: "pause()", group: "Pause" }]);
    expect(r.delegatecall).toBe(true);
    expect(r.selfdestruct).toBe(false);
  });

  it("recognises an EIP-1167 clone", () => {
    const target = "1234567890123456789012345678901234567890";
    expect(minimalProxyTarget(`0x363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3`)?.toLowerCase()).toBe(
      `0x${target}`,
    );
  });
});

const facts = (over: Partial<PassportFacts> = {}): PassportFacts => ({
  chainId: 4663,
  chainName: "Robinhood Chain",
  address: "0x00000000000000000000000000000000000000c8",
  blockNumber: 1,
  code: { exists: true, size: 100, minimalProxyTarget: null },
  flags: decodeFlags("0x00000000000000000000000000000000000000c8"),
  mask: 0xc8,
  invalidPairs: [],
  proxy: { eip1967Implementation: null, eip1967Admin: null, eip1967Beacon: null, eip1822Implementation: null },
  owner: null,
  source: { status: "exact", name: "Hook", url: null },
  bytecode: { delegatecall: false, selfdestruct: false, functions: [] },
  activity: { poolCount: 2, pools: [], swaps: 5 },
  ...over,
});

describe("risk rules", () => {
  it("scores 100 minus the weights of the rules that fired", () => {
    const r = evaluatePassport(facts());
    const ids = r.rules.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["before-swap-delta", "before-swap", "verified", "pools-seen"]));
    expect(r.score).toBe(100 - 30 - 8);
    expect(r.rating).toBe("medium");
  });

  it("rates an address without code as not-a-hook", () => {
    const r = evaluatePassport(facts({ code: { exists: false, size: 0, minimalProxyTarget: null } }));
    expect(r).toMatchObject({ score: 0, rating: "not-a-hook" });
  });

  it("penalises upgradeable, owned, unverified hooks", () => {
    const r = evaluatePassport(
      facts({
        proxy: {
          eip1967Implementation: "0x1111111111111111111111111111111111111111",
          eip1967Admin: null,
          eip1967Beacon: null,
          eip1822Implementation: null,
        },
        owner: { method: "owner()", value: "0x2222222222222222222222222222222222222222" },
        source: { status: "none", name: null, url: null },
      }),
    );
    expect(r.rules.map((x) => x.id)).toEqual(expect.arrayContaining(["upgradeable", "owner-set", "unverified"]));
    expect(r.rating).toBe("very-high");
  });
});

describe("buildPassport", () => {
  it("combines on-chain reads with the pool list", async () => {
    const hook = "0x00000000000000000000000000000000000000c8" as const;
    const registry = new PoolRegistry({
      includeDefaults: false,
      pools: [
        {
          key: {
            currency0: "0x0000000000000000000000000000000000000000",
            currency1: "0x1000000000000000000000000000000000000001",
            fee: 3000,
            tickSpacing: 60,
            hooks: hook,
          },
          swaps: 7,
        },
      ],
    });
    const ctx = { client: mockClient({}), registry, cache: new TtlCache(), now: () => 0 };
    const p = await buildPassport(ctx, hook, { sourcify: false });
    expect(p.code).toEqual({ exists: true, size: 2, minimalProxyTarget: null });
    expect(p.activity).toMatchObject({ poolCount: 1, swaps: 7 });
    expect(p.source.status).toBe("unavailable");
    expect(p.risk.rules.find((r) => r.id === "pools-seen")).toBeTruthy();
    expect(p.generatedAt).toBe("1970-01-01T00:00:00.000Z");
    await expect(buildPassport(ctx, "0x12")).rejects.toThrow("Not an address");
  });
});
