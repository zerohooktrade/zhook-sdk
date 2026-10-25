/**
 * Hook Passport: what a Uniswap v4 hook can do, read from public on-chain data, with a rule-based
 * risk rating (the same rules the Zerohook app shows). The rating is deliberately transparent: every rule that fired is returned with
 * its weight, and the score is simply 100 minus the sum of weights.
 */
import { FLAGS, type FlagKey } from "./permissions.js";

export type RuleLevel = "critical" | "high" | "medium" | "low" | "info" | "pass";

export interface RuleHit {
  id: string;
  level: RuleLevel;
  title: string;
  detail: string;
  /** Points taken off the score of 100. */
  weight: number;
}

export interface PoolSeen {
  poolId: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  /** Block of the Initialize log, when known. */
  block: number | null;
  txHash: `0x${string}` | null;
  /** Swaps in the pool list's activity window. */
  swaps24h?: number;
  /** PositionManager positions ever minted in the pool. */
  positions?: number;
}

export interface PassportFacts {
  chainId: number;
  chainName: string;
  address: `0x${string}`;
  blockNumber: number;
  code: { exists: boolean; size: number; minimalProxyTarget: `0x${string}` | null };
  flags: Record<FlagKey, boolean>;
  mask: number;
  invalidPairs: FlagKey[];
  proxy: {
    eip1967Implementation: `0x${string}` | null;
    eip1967Admin: `0x${string}` | null;
    eip1967Beacon: `0x${string}` | null;
    eip1822Implementation: `0x${string}` | null;
  };
  owner: { method: string; value: `0x${string}` } | null;
  source: { status: "exact" | "partial" | "none" | "unavailable"; name: string | null; url: string | null };
  bytecode: { delegatecall: boolean; selfdestruct: boolean; functions: { signature: string; group: string }[] };
  activity: {
    /** Pools in the pool list that use this hook (list below capped at 50, most swaps first). */
    poolCount: number;
    pools: PoolSeen[];
    /** Swaps recorded for those pools in the pool list's activity window. */
    swaps: number;
  };
}

export interface Passport extends PassportFacts {
  version: 1;
  generatedAt: string;
  risk: { score: number; rating: "not-a-hook" | "low" | "medium" | "high" | "very-high"; rules: RuleHit[] };
  disclaimer: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export const PRIVILEGED_SIGNATURES: { signature: string; group: string }[] = [
  { signature: "transferOwnership(address)", group: "Ownership" },
  { signature: "renounceOwnership()", group: "Ownership" },
  { signature: "setOwner(address)", group: "Ownership" },
  { signature: "grantRole(bytes32,address)", group: "Roles" },
  { signature: "pause()", group: "Pause" },
  { signature: "unpause()", group: "Pause" },
  { signature: "setPaused(bool)", group: "Pause" },
  { signature: "upgradeTo(address)", group: "Upgrade" },
  { signature: "upgradeToAndCall(address,bytes)", group: "Upgrade" },
  { signature: "setFee(uint24)", group: "Fees" },
  { signature: "setFee(uint256)", group: "Fees" },
  { signature: "setFees(uint24,uint24)", group: "Fees" },
  { signature: "setHookFee(uint24)", group: "Fees" },
  { signature: "blacklist(address)", group: "Blocklist" },
  { signature: "setBlacklist(address,bool)", group: "Blocklist" },
  { signature: "addToBlacklist(address)", group: "Blocklist" },
  { signature: "setBlocked(address,bool)", group: "Blocklist" },
  { signature: "withdraw(address,uint256)", group: "Withdraw" },
  { signature: "sweep(address)", group: "Withdraw" },
  { signature: "rescueTokens(address,uint256)", group: "Withdraw" },
];

export function evaluate(f: PassportFacts): Passport["risk"] {
  const rules: RuleHit[] = [];
  const hit = (r: RuleHit) => rules.push(r);

  if (!f.code.exists) {
    hit({
      id: "no-code",
      level: "critical",
      title: "No contract at this address",
      detail:
        "There is no bytecode here — it is a wallet (EOA) or an empty address. It cannot be a working v4 hook. A pool pointing at it would have no hook logic at all.",
      weight: 100,
    });
    return { score: 0, rating: "not-a-hook", rules };
  }

  const set = FLAGS.filter((x) => f.flags[x.key]);
  if (set.length === 0)
    hit({
      id: "no-flags",
      level: "info",
      title: "No permission bits in the address",
      detail:
        "The lowest 14 bits are all zero, so the PoolManager never calls this contract during swaps or liquidity changes. As a v4 hook it could only be used in a dynamic-fee pool, and even then it cannot run callbacks.",
      weight: 0,
    });

  if (f.invalidPairs.length)
    hit({
      id: "invalid-flags",
      level: "high",
      title: "Invalid permission combination",
      detail: `A *ReturnDelta flag is set without its base callback (${f.invalidPairs.join(", ")}). Uniswap v4 refuses to create pools with this hook (Hooks.isValidHookAddress).`,
      weight: 40,
    });

  if (f.flags.beforeSwapReturnDelta)
    hit({
      id: "before-swap-delta",
      level: "high",
      title: "Can rewrite swap amounts before the swap",
      detail:
        "beforeSwapReturnDelta lets the hook take part of your input or replace the pool's pricing entirely. Your trade's result depends on the hook's code, not just the pool curve.",
      weight: 30,
    });
  if (f.flags.afterSwapReturnDelta)
    hit({
      id: "after-swap-delta",
      level: "high",
      title: "Can take a cut of swap output",
      detail:
        "afterSwapReturnDelta lets the hook keep part of what you receive. This charge is separate from, and not limited by, the pool's LP fee.",
      weight: 20,
    });
  if (f.flags.afterAddLiquidityReturnDelta || f.flags.afterRemoveLiquidityReturnDelta)
    hit({
      id: "liquidity-delta",
      level: "medium",
      title: "Can change what LPs pay or receive",
      detail: "A liquidity ReturnDelta flag lets the hook charge LPs when they add or take part of what they withdraw.",
      weight: 10,
    });
  if (f.flags.beforeRemoveLiquidity)
    hit({
      id: "before-remove",
      level: "medium",
      title: "Can block liquidity withdrawals",
      detail:
        "beforeRemoveLiquidity can refuse removals. That is how liquidity locks work — but it can also trap LPs. Check the source for when removals are allowed.",
      weight: 8,
    });
  if (f.flags.beforeSwap)
    hit({
      id: "before-swap",
      level: "medium",
      title: "Can refuse swaps",
      detail:
        "beforeSwap runs before every trade and can revert it — for example to block sells or specific wallets — and can set per-trade fees in dynamic-fee pools.",
      weight: 8,
    });

  const upgrade = f.proxy.eip1967Implementation || f.proxy.eip1822Implementation || f.proxy.eip1967Beacon;
  if (upgrade)
    hit({
      id: "upgradeable",
      level: "high",
      title: "Upgradeable proxy",
      detail: `The hook delegates to ${upgrade}. Whoever controls the upgrade can replace the logic at any time — every other finding here can change.${f.proxy.eip1967Admin ? ` Proxy admin: ${f.proxy.eip1967Admin}.` : ""}`,
      weight: 25,
    });
  if (f.code.minimalProxyTarget)
    hit({
      id: "minimal-proxy",
      level: "low",
      title: "Minimal proxy (clone)",
      detail: `This is an EIP-1167 clone of ${f.code.minimalProxyTarget}. The logic lives there and cannot change, but review that contract.`,
      weight: 3,
    });

  if (f.owner) {
    if (f.owner.value.toLowerCase() === ZERO)
      hit({
        id: "owner-renounced",
        level: "pass",
        title: "Owner renounced",
        detail: `${f.owner.method} returns the zero address.`,
        weight: 0,
      });
    else
      hit({
        id: "owner-set",
        level: "medium",
        title: "Has an owner",
        detail: `${f.owner.method} returns ${f.owner.value}. Owner-only functions may change hook behaviour; check what they can change and within which limits.`,
        weight: 10,
      });
  } else
    hit({
      id: "no-owner-fn",
      level: "info",
      title: "No standard owner function",
      detail:
        "owner(), getOwner() and admin() did not return an address. Access control may still exist under other names.",
      weight: 0,
    });

  if (f.source.status === "exact")
    hit({
      id: "verified",
      level: "pass",
      title: "Source verified (exact match)",
      detail: `Sourcify has an exact match${f.source.name ? ` for ${f.source.name}` : ""}.`,
      weight: 0,
    });
  else if (f.source.status === "partial")
    hit({
      id: "verified-partial",
      level: "low",
      title: "Source verified (partial match)",
      detail: "Sourcify matches the code but not its metadata.",
      weight: 3,
    });
  else if (f.source.status === "none")
    hit({
      id: "unverified",
      level: "medium",
      title: "Source not verified on Sourcify",
      detail:
        "Without published source you only have the bytecode. It may be verified on a block explorer — check there.",
      weight: 12,
    });
  else
    hit({
      id: "source-unknown",
      level: "info",
      title: "Source check unavailable",
      detail: "Sourcify could not be reached for this check.",
      weight: 0,
    });

  if (f.bytecode.delegatecall && !upgrade && !f.code.minimalProxyTarget)
    hit({
      id: "delegatecall",
      level: "medium",
      title: "Uses DELEGATECALL",
      detail:
        "The bytecode contains DELEGATECALL, so it can run code from another contract in its own context. (Heuristic opcode scan.)",
      weight: 6,
    });
  if (f.bytecode.selfdestruct)
    hit({
      id: "selfdestruct",
      level: "low",
      title: "Contains SELFDESTRUCT",
      detail:
        "Since EIP-6780 this can only delete code created in the same transaction, but it can still move the contract's ETH. (Heuristic opcode scan.)",
      weight: 4,
    });

  const groups = [...new Set(f.bytecode.functions.map((x) => x.group))];
  const sensitive = groups.filter((g) => ["Pause", "Blocklist", "Fees", "Withdraw", "Upgrade"].includes(g));
  if (sensitive.length)
    hit({
      id: "privileged-functions",
      level: "medium",
      title: `Admin-style functions found: ${sensitive.join(", ")}`,
      detail: `Function selectors in the bytecode match: ${f.bytecode.functions.map((x) => x.signature).join(", ")}. A match means the function exists, not who may call it. (Selector scan.)`,
      weight: Math.min(15, sensitive.length * 5),
    });

  if (f.activity.poolCount)
    hit({
      id: "pools-seen",
      level: "info",
      title: `${f.activity.poolCount.toLocaleString("en-US")} pool${f.activity.poolCount > 1 ? "s" : ""} use this hook`,
      detail: `Counted from the pool list in use (the bundled default set plus any pools passed in or discovered). ${f.activity.swaps} swaps through its pools in that list's activity window.`,
      weight: 0,
    });
  else
    hit({
      id: "no-pools-seen",
      level: "info",
      title: "No pools found with this hook",
      detail:
        "No pool in the pool list in use points at this address. Discover recent pools from PoolManager Initialize logs, or pass a larger pool list, to look further.",
      weight: 0,
    });

  const score = Math.max(0, 100 - rules.reduce((a, r) => a + r.weight, 0));
  const rating = score >= 80 ? "low" : score >= 55 ? "medium" : score >= 30 ? "high" : "very-high";
  return { score, rating, rules };
}

export const RATING_LABEL: Record<Passport["risk"]["rating"], string> = {
  "not-a-hook": "Not a hook",
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  "very-high": "Very high risk",
};

export const DISCLAIMER =
  "Rule-based reading of public on-chain data. It describes what the hook is able to do, not whether its operators will do it. Not financial advice.";
