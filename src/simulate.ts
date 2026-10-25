/**
 * eth_call simulation of a swap before signing, plus the approvals an ERC-20 input needs (ERC-20 → Permit2, then
 * Permit2 → Universal Router). Nothing here signs or sends: it only reads, and builds calldata for the caller's wallet.
 */
import { encodeFunctionData, maxUint160, maxUint256, type Hex, type PublicClient, type StateOverride } from "viem";
import { erc20Abi, permit2Abi } from "./abis.js";
import { NATIVE, RHC, type Address } from "./chain.js";

export interface Simulation {
  ok: boolean;
  /** eth_estimateGas of the call, when it passes. */
  gasEstimate: string | null;
  /** First line of the revert reason, when it fails. */
  error: string | null;
  /** Whether a state override was applied (for example a funded ETH balance). */
  overridden: boolean;
}

export interface SimulateParams {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  /** Extra state overrides for eth_call / eth_estimateGas. */
  stateOverride?: StateOverride;
  /** Give `from` enough ETH for value + gas through a state override (dry runs from an empty wallet). */
  fundEth?: boolean;
}

const firstLine = (e: unknown) =>
  (((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)) as string)
    .split("\n")[0]!
    .slice(0, 240);

/** Run the transaction with eth_call from `from`, then estimate its gas. Never throws on a revert. */
export async function simulateTx(client: PublicClient, p: SimulateParams): Promise<Simulation> {
  const stateOverride: StateOverride = [...(p.stateOverride ?? [])];
  if (p.fundEth) stateOverride.push({ address: p.from, balance: (p.value ?? 0n) + 10n ** 18n });
  const overridden = stateOverride.length > 0;
  const base = {
    account: p.from,
    to: p.to,
    data: p.data,
    value: p.value ?? 0n,
    ...(overridden ? { stateOverride } : {}),
  };
  try {
    await client.call(base);
  } catch (e) {
    return { ok: false, gasEstimate: null, error: firstLine(e), overridden };
  }
  try {
    const gas = await client.estimateGas(base);
    return { ok: true, gasEstimate: gas.toString(), error: null, overridden };
  } catch (e) {
    return { ok: false, gasEstimate: null, error: firstLine(e), overridden };
  }
}

export interface ApprovalStatus {
  token: Address;
  owner: Address;
  balance: string;
  /** ERC-20 allowance from owner to Permit2. */
  permit2Allowance: string;
  /** Permit2 allowance from owner to the Universal Router. */
  routerAllowance: string;
  routerAllowanceExpiration: number;
  /** Steps still needed before a swap of `amount` can execute. */
  missing: ("balance" | "erc20-approve-permit2" | "permit2-approve-router")[];
}

/** Balance and the two allowances an ERC-20 swap through Permit2 needs. */
export async function approvalStatus(
  client: PublicClient,
  owner: Address,
  token: Address,
  amount: bigint,
  now = Date.now(),
): Promise<ApprovalStatus> {
  if (token.toLowerCase() === NATIVE) throw new Error("native ETH needs no approval");
  const [balance, erc20Allowance, p2] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, RHC.permit2] }),
    client.readContract({
      address: RHC.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [owner, token, RHC.universalRouter],
    }),
  ]);
  const [p2Amount, p2Expiration] = p2;
  const missing: ApprovalStatus["missing"] = [];
  if (balance < amount) missing.push("balance");
  if (erc20Allowance < amount) missing.push("erc20-approve-permit2");
  if (p2Amount < amount || p2Expiration * 1000 <= now) missing.push("permit2-approve-router");
  return {
    token,
    owner,
    balance: balance.toString(),
    permit2Allowance: erc20Allowance.toString(),
    routerAllowance: p2Amount.toString(),
    routerAllowanceExpiration: p2Expiration,
    missing,
  };
}

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: string;
  description: string;
}

/**
 * Calldata for the two approvals of an ERC-20 input: token.approve(Permit2, max) and
 * Permit2.approve(token, router, amount, expiration). Amount defaults to the uint160 max, expiration to 30 days.
 */
export function approvalTxs(
  token: Address,
  options: { amount?: bigint; expiration?: number; now?: number } = {},
): UnsignedTx[] {
  const expiration = options.expiration ?? Math.floor((options.now ?? Date.now()) / 1000) + 30 * 86_400;
  return [
    {
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RHC.permit2, maxUint256] }),
      value: "0",
      description: "Allow Permit2 to move this token",
    },
    {
      to: RHC.permit2,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [token, RHC.universalRouter, options.amount ?? maxUint160, expiration],
      }),
      value: "0",
      description: "Allow the Universal Router to pull this token through Permit2",
    },
  ];
}
