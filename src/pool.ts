import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex, type PublicClient } from "viem";
import { erc20Abi, positionManagerAbi, stateViewAbi } from "./abis.js";
import { DYNAMIC_FEE_FLAG, NATIVE, RHC, type Address } from "./chain.js";
import { ZhookError } from "./errors.js";

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** PoolId = keccak256(abi.encode(PoolKey)), v4-core PoolIdLibrary. */
export function poolIdOf(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

/** Price of currency0 in currency1 units (human), from sqrtPriceX96. */
export function priceFromSqrt(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s * 10 ** (dec0 - dec1);
}

/** "0.3%", "0.0005%" or "dynamic". */
export function feeLabel(fee: number) {
  if (fee === DYNAMIC_FEE_FLAG) return "dynamic";
  return `${+(fee / 10_000).toFixed(4)}%`;
}

export const isHooked = (key: PoolKey) => key.hooks.toLowerCase() !== NATIVE;

export interface TokenMeta {
  address: Address;
  symbol: string;
  decimals: number;
  native: boolean;
}

export interface PoolState {
  chainId: number;
  poolId: `0x${string}`;
  key: PoolKey | null;
  keySource: "position-manager" | "registry" | "input" | null;
  initialized: boolean;
  sqrtPriceX96: string;
  tick: number;
  lpFee: number;
  protocolFee: number;
  liquidity: string;
  token0: TokenMeta | null;
  token1: TokenMeta | null;
  /** currency1 per currency0 */
  price: number | null;
  blockNumber: number;
}

async function tokenMeta(client: PublicClient, address: Address): Promise<TokenMeta> {
  if (address.toLowerCase() === NATIVE) return { address, symbol: RHC.native, decimals: 18, native: true };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  return { address, symbol: String(symbol).slice(0, 24), decimals: Number(decimals), native: false };
}

/**
 * Live state of a v4 pool: slot0, liquidity and token metadata. The PoolKey comes from `key`, then from the
 * PositionManager, then from `lookup` (for example a registry).
 */
export async function readPoolState(
  client: PublicClient,
  poolId: string,
  options: { key?: PoolKey; lookup?: (id: `0x${string}`) => PoolKey | null } = {},
): Promise<PoolState> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new ZhookError(400, "Pool ID must be 32 bytes hex");
  const id = poolId.toLowerCase() as `0x${string}`;
  let key: PoolKey | null = options.key ?? null;
  let keySource: PoolState["keySource"] = key ? "input" : null;
  if (!key) {
    try {
      const k = await client.readContract({
        address: RHC.v4.positionManager,
        abi: positionManagerAbi,
        functionName: "poolKeys",
        args: [id.slice(0, 52) as Hex],
      });
      const cand: PoolKey = { currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] };
      if (poolIdOf(cand) === id) {
        key = cand;
        keySource = "position-manager";
      }
    } catch {
      /* not known to PositionManager */
    }
  }
  if (!key && options.lookup) {
    key = options.lookup(id);
    if (key) keySource = "registry";
  }
  const [slot0, liquidity, block] = await Promise.all([
    client.readContract({ address: RHC.v4.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
    client.readContract({ address: RHC.v4.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
    client.getBlockNumber(),
  ]);
  const [sqrtPriceX96, tick, protocolFee, lpFee] = slot0;
  const [token0, token1] = key
    ? await Promise.all([tokenMeta(client, key.currency0), tokenMeta(client, key.currency1)])
    : [null, null];
  return {
    chainId: RHC.id,
    poolId: id,
    key,
    keySource,
    initialized: sqrtPriceX96 > 0n,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    lpFee,
    protocolFee,
    liquidity: liquidity.toString(),
    token0,
    token1,
    price: token0 && token1 && sqrtPriceX96 > 0n ? priceFromSqrt(sqrtPriceX96, token0.decimals, token1.decimals) : null,
    blockNumber: Number(block),
  };
}
