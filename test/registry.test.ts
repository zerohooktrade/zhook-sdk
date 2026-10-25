import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, pad } from "viem";
import {
  decodeInitialize,
  DEFAULT_POOL_ROWS,
  defaultRegistry,
  discoverPools,
  inputToRow,
  NATIVE,
  poolIdOf,
  PoolRegistry,
  poolManagerEvents,
  RHC,
  rowToInput,
  STOCK_CANDIDATES,
} from "../src/index.js";

const ETH_USDG = {
  currency0: NATIVE,
  currency1: RHC.usdg.toLowerCase() as `0x${string}`,
  fee: 500,
  tickSpacing: 10,
  hooks: NATIVE,
};

describe("poolIdOf", () => {
  it("matches PoolIdLibrary (keccak256(abi.encode(PoolKey)))", () => {
    // Pool id of the ETH/USDG 0.05 % pool as shown in the Zerohook app and on-chain.
    expect(poolIdOf(ETH_USDG)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolIdOf(ETH_USDG)).toBe(poolIdOf({ ...ETH_USDG, currency1: RHC.usdg.toLowerCase() as `0x${string}` }));
    expect(poolIdOf(ETH_USDG)).not.toBe(poolIdOf({ ...ETH_USDG, fee: 3000 }));
  });
});

describe("default registry", () => {
  const r = defaultRegistry();

  it("bundles a small default pool set", () => {
    expect(r.size).toBe(DEFAULT_POOL_ROWS.length);
    expect(r.size).toBeGreaterThan(300);
    expect(r.size).toBeLessThan(1000);
  });

  it("covers the core ETH / USDG pools in both orders", () => {
    const a = r.forPair(NATIVE, RHC.usdg);
    expect(a.length).toBeGreaterThan(5);
    expect(r.forPair(RHC.usdg, NATIVE)).toHaveLength(a.length);
    expect(a.some((p) => p.key.fee === 500 && p.key.tickSpacing === 10 && p.key.hooks === NATIVE)).toBe(true);
    expect(a.every((p) => p.source === "default")).toBe(true);
  });

  it("indexes hooked pools by hook with codehash pins", () => {
    const hooks = r.hooks();
    expect(hooks.length).toBeGreaterThan(10);
    for (let i = 1; i < hooks.length; i++) expect(hooks[i - 1]!.swaps).toBeGreaterThanOrEqual(hooks[i]!.swaps);
    const top = hooks[0]!;
    expect(r.forHook(top.hook)).toHaveLength(top.pools);
    expect(top.pin?.codehash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("knows token metadata of the default set", () => {
    expect(r.token(RHC.usdg)).toEqual({ symbol: "USDG", decimals: 6 });
    expect(r.tokenAddresses().length).toBeGreaterThan(50);
  });

  it("ships stock-token candidates as checksummed-or-lowercase addresses", () => {
    expect(STOCK_CANDIDATES.length).toBeGreaterThan(100);
    for (const a of STOCK_CANDIDATES) expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("custom registry", () => {
  it("adds pools from objects and rows, deduplicated by pool id", () => {
    const r = new PoolRegistry({
      includeDefaults: false,
      pools: [{ key: ETH_USDG, swaps: 3 }, inputToRow({ key: ETH_USDG })],
    });
    expect(r.size).toBe(1);
    expect(r.get(poolIdOf(ETH_USDG))?.swaps).toBe(3);
    expect(r.add([{ key: { ...ETH_USDG, fee: 3000, tickSpacing: 60 } }])).toBe(1);
    expect(r.forPair(NATIVE, RHC.usdg)).toHaveLength(2);
  });

  it("round-trips compact rows", () => {
    const row = DEFAULT_POOL_ROWS[0]!;
    expect(inputToRow(rowToInput(row))).toEqual([row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]]);
    const r = new PoolRegistry();
    expect(new PoolRegistry({ includeDefaults: false, pools: r.toRows() }).size).toBe(r.size);
  });
});

describe("discovery from Initialize logs", () => {
  const hook = "0x0000000000000000000000000000000000000080" as const;
  const key = {
    currency0: NATIVE,
    currency1: RHC.usdg.toLowerCase() as `0x${string}`,
    fee: 8388608,
    tickSpacing: 200,
    hooks: hook,
  };
  const id = poolIdOf(key);
  const topics = encodeEventTopics({
    abi: poolManagerEvents,
    eventName: "Initialize",
    args: { id, currency0: key.currency0, currency1: key.currency1 },
  });
  const data = encodeAbiParameters(
    [{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
    [key.fee, key.tickSpacing, key.hooks, 79228162514264337593543950336n, 0],
  );
  const log = {
    address: RHC.v4.poolManager,
    topics: topics as `0x${string}`[],
    data,
    blockNumber: "0x10" as const,
    transactionHash: pad("0x01", { size: 32 }),
    logIndex: "0x0" as const,
  };

  it("decodes a PoolManager Initialize log into a pool", () => {
    const p = decodeInitialize(log);
    expect(p.id).toBe(id);
    expect(p.key).toEqual(key);
    expect(p.firstBlock).toBe(16);
    expect(p.sqrtPriceX96).toBe(2n ** 96n);
  });

  it("scans a block range over JSON-RPC and fills a registry", async () => {
    const seen: unknown[] = [];
    const fetchMock = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { params: unknown[] };
      seen.push(body.params[0]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: seen.length === 1 ? [log] : [] }));
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const registry = new PoolRegistry({ includeDefaults: false });
      const r = await discoverPools({ fromBlock: 1000, toBlock: 3100, registry, span: 1000 });
      expect(r.complete).toBe(true);
      expect(r.pools).toHaveLength(1);
      expect(registry.get(id)?.source).toBe("discovered");
      expect(registry.forHook(hook)).toHaveLength(1);
      // 3100 minus the head margin (48 blocks), in 1,000-block chunks.
      expect(seen).toHaveLength(3);
      expect(seen[0]).toMatchObject({ address: RHC.v4.poolManager, fromBlock: "0x3e8", toBlock: "0x7cf" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
