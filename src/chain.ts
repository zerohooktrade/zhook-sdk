/**
 * Robinhood Chain (4663): the only chain Zerohook trades on.
 *
 * Every address below was checked on-chain with eth_getCode (and, where a contract points at another, by reading that
 * pointer) on 2026-10-25:
 *  - Uniswap v4 PoolManager / PositionManager / StateView / V4Quoter: from Uniswap's deployments page.
 *    UniversalRouter.poolManager() returns the PoolManager below.
 *  - v3 Factory and WETH9: read from QuoterV2.factory() / QuoterV2.WETH9().
 *  - Permit2: canonical address.
 * Runtime codehashes are pinned in ./pins.ts and re-checked before quoting.
 */
export type Address = `0x${string}`;

export interface ChainConfig {
  id: number;
  name: string;
  native: string;
  explorer: string;
  /** Public read RPCs (eth_call at latest), tried in order. */
  rpcs: string[];
  /** Public eth_getLogs RPCs, tried in order. */
  logRpcs: string[];
  /** Max block span per eth_getLogs call on logRpcs. */
  logSpan: number;
  /** Seconds per block (measured: 978,858 blocks over 102,867 s, about 0.105 s). */
  blockTime: number;
  v4: { poolManager: Address; positionManager: Address; stateView: Address; quoter: Address };
  v3: { factory: Address; quoterV2: Address; swapRouter02: Address };
  universalRouter: Address;
  permit2: Address;
  weth: Address;
  usdg: Address;
  multicall3: Address;
}

/**
 * Robinhood Chain with public, keyless RPCs only. Measured 2026-10-25: publicnode answers eth_call but refuses
 * eth_getLogs; thirdweb's public endpoint answers 1,000-block log ranges.
 */
export const RHC: ChainConfig = {
  id: 4663,
  name: "Robinhood Chain",
  native: "ETH",
  explorer: "https://robinhoodchain.blockscout.com",
  rpcs: ["https://robinhood-rpc.publicnode.com", "https://4663.rpc.thirdweb.com"],
  logRpcs: ["https://4663.rpc.thirdweb.com"],
  logSpan: 1000,
  blockTime: 0.105,
  v4: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  },
  v3: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  },
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

export const explorerAddress = (address: string, chain: ChainConfig = RHC) => `${chain.explorer}/address/${address}`;
export const explorerTx = (hash: string, chain: ChainConfig = RHC) => `${chain.explorer}/tx/${hash}`;

/** Uniswap v4 dynamic-fee flag in PoolKey.fee (LPFeeLibrary.DYNAMIC_FEE_FLAG). */
export const DYNAMIC_FEE_FLAG = 0x800000;
/** Native ETH in v4 PoolKeys and in this SDK's API. */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** v3 fee tiers enabled on the Robinhood Chain v3 factory (asked in this order). */
export const V3_FEES = [100, 500, 3000, 10000] as const;
/** EIP-1967 implementation slot. */
export const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
