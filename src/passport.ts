/** Hook Passport builder: reads a hook's code, proxy slots, owner, source verification and pools, then rates it. */
import { getAddress, toFunctionSelector, type Hex } from "viem";
import { RHC } from "./chain.js";
import { ZhookError } from "./errors.js";
import { ALL_HOOK_MASK, decodeFlags, invalidDeltaPairs } from "./permissions.js";
import {
  DISCLAIMER,
  evaluate,
  PRIVILEGED_SIGNATURES,
  type Passport,
  type PassportFacts,
  type PoolSeen,
} from "./passport-rules.js";
import type { EngineContext } from "./quote.js";

const SLOT = {
  eip1967Impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  eip1822: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
} as const;

const OWNER_CALLS: [string, Hex][] = [
  ["owner()", "0x8da5cb5b"],
  ["getOwner()", "0x893d20e8"],
  ["admin()", "0xf851a440"],
];

const SELECTORS = PRIVILEGED_SIGNATURES.map((s) => ({
  ...s,
  selector: toFunctionSelector(`function ${s.signature}`).slice(2),
}));

function slotToAddress(v: Hex | undefined): `0x${string}` | null {
  if (!v || /^0x0*$/.test(v)) return null;
  const a = "0x" + v.slice(-40);
  return /^0x0{40}$/.test(a) ? null : (getAddress(a) as `0x${string}`);
}

/** Walk opcodes (skipping PUSH data) up to the CBOR metadata; collect PUSH4 values and flags. */
export function scanBytecode(code: Hex) {
  const bytes = code.slice(2);
  let end = bytes.length / 2;
  if (end > 2) {
    const metaLen = parseInt(bytes.slice(-4), 16);
    const start = end - metaLen - 2;
    if (metaLen > 0 && start > 0 && ["a1", "a2", "a3", "a4"].includes(bytes.slice(start * 2, start * 2 + 2)))
      end = start;
  }
  const push4 = new Set<string>();
  let delegatecall = false;
  let selfdestruct = false;
  for (let i = 0; i < end; i++) {
    const op = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
    if (op === 0xf4) delegatecall = true;
    else if (op === 0xff) selfdestruct = true;
    else if (op === 0x63) push4.add(bytes.slice((i + 1) * 2, (i + 5) * 2));
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  const functions = SELECTORS.filter((s) => push4.has(s.selector)).map(({ signature, group }) => ({
    signature,
    group,
  }));
  return { delegatecall, selfdestruct, functions };
}

export function minimalProxyTarget(code: Hex): `0x${string}` | null {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
  return m ? (getAddress("0x" + m[1]) as `0x${string}`) : null;
}

async function sourceCheck(address: string, fetchImpl: typeof fetch): Promise<PassportFacts["source"]> {
  try {
    const r = await fetchImpl(`https://sourcify.dev/server/v2/contract/${RHC.id}/${address}?fields=compilation`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) return { status: "none", name: null, url: null };
    if (!r.ok) return { status: "unavailable", name: null, url: null };
    const j = (await r.json()) as { match?: string | null; compilation?: { name?: string } };
    const url = `https://repo.sourcify.dev/${RHC.id}/${address}`;
    if (j.match === "exact_match") return { status: "exact", name: j.compilation?.name ?? null, url };
    if (j.match === "match") return { status: "partial", name: j.compilation?.name ?? null, url };
    return { status: "none", name: null, url: null };
  } catch {
    return { status: "unavailable", name: null, url: null };
  }
}

function activity(ctx: EngineContext, hook: `0x${string}`): PassportFacts["activity"] {
  const pools = ctx.registry.forHook(hook);
  const seen: PoolSeen[] = pools
    .sort((a, b) => b.swaps - a.swaps || (b.liquidity > a.liquidity ? 1 : -1))
    .slice(0, 50)
    .map((p) => ({
      poolId: p.id,
      currency0: p.key.currency0,
      currency1: p.key.currency1,
      fee: p.key.fee,
      tickSpacing: p.key.tickSpacing,
      block: p.firstBlock,
      txHash: (p.initTx as `0x${string}` | null) ?? null,
      swaps24h: p.swaps,
      positions: p.positions,
    }));
  return { poolCount: pools.length, pools: seen, swaps: pools.reduce((s, p) => s + p.swaps, 0) };
}

export interface PassportOptions {
  /** Look the hook up on Sourcify (default true). */
  sourcify?: boolean;
  fetch?: typeof fetch;
}

/** Build a Hook Passport for a hook address on Robinhood Chain. */
export async function buildPassport(
  ctx: EngineContext,
  hookInput: string,
  options: PassportOptions = {},
): Promise<Passport> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(hookInput)) throw new ZhookError(400, "Not an address");
  const address = getAddress(hookInput) as `0x${string}`;
  const client = ctx.client;
  const [head, rawCode] = await Promise.all([client.getBlockNumber(), client.getCode({ address })]);
  const code = (rawCode ?? "0x") as Hex;
  const exists = code !== "0x" && code.length > 2;
  const flags = decodeFlags(address);
  const mask = Number(BigInt(address) & BigInt(ALL_HOOK_MASK));

  const facts: PassportFacts = {
    chainId: RHC.id,
    chainName: RHC.name,
    address,
    blockNumber: Number(head),
    code: {
      exists,
      size: exists ? (code.length - 2) / 2 : 0,
      minimalProxyTarget: exists ? minimalProxyTarget(code) : null,
    },
    flags,
    mask,
    invalidPairs: invalidDeltaPairs(flags).map((f) => f.key),
    proxy: { eip1967Implementation: null, eip1967Admin: null, eip1967Beacon: null, eip1822Implementation: null },
    owner: null,
    source: { status: "unavailable", name: null, url: null },
    bytecode: { delegatecall: false, selfdestruct: false, functions: [] },
    activity: activity(ctx, address),
  };

  if (exists) {
    const [slots, owners, source] = await Promise.all([
      Promise.all(
        Object.values(SLOT).map((slot) => client.getStorageAt({ address, slot: slot as Hex }).catch(() => undefined)),
      ),
      Promise.all(
        OWNER_CALLS.map(async ([method, data]) => {
          try {
            const r = await client.call({ to: address, data });
            if (!r.data || r.data.length !== 66 || !/^0x0{24}/.test(r.data)) return null;
            return { method, value: getAddress("0x" + r.data.slice(26)) as `0x${string}` };
          } catch {
            return null;
          }
        }),
      ),
      options.sourcify === false
        ? Promise.resolve<PassportFacts["source"]>({ status: "unavailable", name: null, url: null })
        : sourceCheck(address, options.fetch ?? fetch),
    ]);
    facts.proxy = {
      eip1967Implementation: slotToAddress(slots[0]),
      eip1967Admin: slotToAddress(slots[1]),
      eip1967Beacon: slotToAddress(slots[2]),
      eip1822Implementation: slotToAddress(slots[3]),
    };
    facts.owner = owners.find((o) => o) ?? null;
    facts.source = source;
    facts.bytecode = scanBytecode(code);
  }

  return {
    version: 1,
    generatedAt: new Date(ctx.now()).toISOString(),
    ...facts,
    risk: evaluate(facts),
    disclaimer: DISCLAIMER,
  };
}
