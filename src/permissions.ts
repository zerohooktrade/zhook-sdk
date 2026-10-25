/**
 * Uniswap v4 hook permission flags.
 *
 * Bit layout verified 2026-10-08 against v4-core `src/libraries/Hooks.sol` (main):
 * a hook's permissions are encoded in the LOWEST 14 BITS of its address (ALL_HOOK_MASK = (1 << 14) - 1).
 * The PoolManager only calls a callback if the matching bit is set, so the address alone tells a
 * trader which callbacks a hook can run — no source code needed.
 */

export type FlagKey =
  | "beforeInitialize"
  | "afterInitialize"
  | "beforeAddLiquidity"
  | "afterAddLiquidity"
  | "beforeRemoveLiquidity"
  | "afterRemoveLiquidity"
  | "beforeSwap"
  | "afterSwap"
  | "beforeDonate"
  | "afterDonate"
  | "beforeSwapReturnDelta"
  | "afterSwapReturnDelta"
  | "afterAddLiquidityReturnDelta"
  | "afterRemoveLiquidityReturnDelta";

export type Impact = "info" | "low" | "medium" | "high";

export interface FlagDef {
  key: FlagKey;
  bit: number;
  /** Solidity constant name in Hooks.sol. */
  constant: string;
  label: string;
  /** What the callback is. */
  what: string;
  /** What it means for a trader or LP, plainly. */
  power: string;
  impact: Impact;
  /** For *ReturnDelta flags: the base callback it depends on. */
  requires?: FlagKey;
}

export const FLAGS: FlagDef[] = [
  {
    key: "beforeInitialize",
    bit: 13,
    constant: "BEFORE_INITIALIZE_FLAG",
    label: "beforeInitialize",
    what: "Runs before a pool using this hook is created.",
    power: "Can refuse to create a pool or check who creates it. No effect on trades after launch.",
    impact: "info",
  },
  {
    key: "afterInitialize",
    bit: 12,
    constant: "AFTER_INITIALIZE_FLAG",
    label: "afterInitialize",
    what: "Runs right after a pool is created.",
    power: "Usually records launch state (start block, owner settings). No direct effect on trades.",
    impact: "info",
  },
  {
    key: "beforeAddLiquidity",
    bit: 11,
    constant: "BEFORE_ADD_LIQUIDITY_FLAG",
    label: "beforeAddLiquidity",
    what: "Runs before anyone adds liquidity.",
    power: "Can block or restrict who adds liquidity.",
    impact: "low",
  },
  {
    key: "afterAddLiquidity",
    bit: 10,
    constant: "AFTER_ADD_LIQUIDITY_FLAG",
    label: "afterAddLiquidity",
    what: "Runs after liquidity is added.",
    power: "Can track or react to new liquidity. Can revert the add.",
    impact: "low",
  },
  {
    key: "beforeRemoveLiquidity",
    bit: 9,
    constant: "BEFORE_REMOVE_LIQUIDITY_FLAG",
    label: "beforeRemoveLiquidity",
    what: "Runs before anyone removes liquidity.",
    power: "Can block liquidity withdrawals — used for locks, but also able to trap LPs.",
    impact: "medium",
  },
  {
    key: "afterRemoveLiquidity",
    bit: 8,
    constant: "AFTER_REMOVE_LIQUIDITY_FLAG",
    label: "afterRemoveLiquidity",
    what: "Runs after liquidity is removed.",
    power: "Can track withdrawals. Can revert the removal.",
    impact: "low",
  },
  {
    key: "beforeSwap",
    bit: 7,
    constant: "BEFORE_SWAP_FLAG",
    label: "beforeSwap",
    what: "Runs before every swap.",
    power:
      "Can revert any swap (for example block sells or specific wallets) and, in dynamic-fee pools, set the fee for each trade.",
    impact: "medium",
  },
  {
    key: "afterSwap",
    bit: 6,
    constant: "AFTER_SWAP_FLAG",
    label: "afterSwap",
    what: "Runs after every swap.",
    power: "Can track flow, update state, or revert a swap after seeing its result.",
    impact: "low",
  },
  {
    key: "beforeDonate",
    bit: 5,
    constant: "BEFORE_DONATE_FLAG",
    label: "beforeDonate",
    what: "Runs before a donation to in-range LPs.",
    power: "Can block donations. Rarely relevant to traders.",
    impact: "info",
  },
  {
    key: "afterDonate",
    bit: 4,
    constant: "AFTER_DONATE_FLAG",
    label: "afterDonate",
    what: "Runs after a donation to in-range LPs.",
    power: "Can track donations. Rarely relevant to traders.",
    impact: "info",
  },
  {
    key: "beforeSwapReturnDelta",
    bit: 3,
    constant: "BEFORE_SWAP_RETURNS_DELTA_FLAG",
    label: "beforeSwap → returns delta",
    what: "beforeSwap may return its own token amounts that change the swap.",
    power:
      "Can take part of your input, replace the pool's pricing entirely (custom curve / NoOp), or change what you receive. The strongest power a hook can have.",
    impact: "high",
    requires: "beforeSwap",
  },
  {
    key: "afterSwapReturnDelta",
    bit: 2,
    constant: "AFTER_SWAP_RETURNS_DELTA_FLAG",
    label: "afterSwap → returns delta",
    what: "afterSwap may return a token amount that changes the swap result.",
    power: "Can take a cut of what you receive (a hook fee) — the cut is not limited by the pool's LP fee.",
    impact: "high",
    requires: "afterSwap",
  },
  {
    key: "afterAddLiquidityReturnDelta",
    bit: 1,
    constant: "AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG",
    label: "afterAddLiquidity → returns delta",
    what: "afterAddLiquidity may change the amounts an LP pays.",
    power: "Can charge LPs extra when they add liquidity.",
    impact: "medium",
    requires: "afterAddLiquidity",
  },
  {
    key: "afterRemoveLiquidityReturnDelta",
    bit: 0,
    constant: "AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG",
    label: "afterRemoveLiquidity → returns delta",
    what: "afterRemoveLiquidity may change the amounts an LP receives.",
    power: "Can take part of what LPs withdraw.",
    impact: "medium",
    requires: "afterRemoveLiquidity",
  },
];

export const ALL_HOOK_MASK = (1 << 14) - 1;

export function flagByKey(key: FlagKey): FlagDef {
  return FLAGS.find((f) => f.key === key)!;
}

/** Read the 14 permission bits from a hook address (works for any 20-byte hex address). */
export function decodeFlags(address: string): Record<FlagKey, boolean> {
  const low = Number(BigInt(address) & BigInt(ALL_HOOK_MASK));
  const out = {} as Record<FlagKey, boolean>;
  for (const f of FLAGS) out[f.key] = (low & (1 << f.bit)) !== 0;
  return out;
}

export function maskOf(flags: Iterable<FlagKey>): number {
  let m = 0;
  for (const k of flags) m |= 1 << flagByKey(k).bit;
  return m;
}

export function maskHex(mask: number) {
  return "0x" + mask.toString(16).padStart(4, "0");
}

export function maskBinary(mask: number) {
  return mask.toString(2).padStart(14, "0");
}

/**
 * Mirror of Hooks.isValidHookAddress: a *ReturnDelta flag without its base callback flag makes
 * the address unusable as a hook (PoolManager.initialize reverts). Returns the broken pairs.
 */
export function invalidDeltaPairs(flags: Record<FlagKey, boolean>): FlagDef[] {
  return FLAGS.filter((f) => f.requires && flags[f.key] && !flags[f.requires]);
}
