/**
 * Route model + Universal Router calldata for public trades on Robinhood Chain (the encoder the Zerohook app uses).
 *
 * Every route is encoded the same way, so there is one shape to test:
 *   1. input lands in the router: ERC-20 via PERMIT2_TRANSFER_FROM (needs a Permit2 allowance to the router),
 *      native ETH via msg.value;
 *   2. each leg runs its hops with the router as payer and recipient (v3: V3_SWAP_EXACT_IN payerIsUser=false;
 *      v4: V4_SWAP [SETTLE(router-paid) → SWAP_EXACT_IN_SINGLE(open delta) → TAKE(router, open delta)]),
 *      wrapping/unwrapping between native ETH and WETH where a hop needs the other form;
 *   3. optional integrator fee: PAY_PORTION(tokenOut, recipient, bips) — capped at 50 bips;
 *   4. SWEEP(tokenOut, msg.sender, minOut) — the guaranteed minimum: the whole transaction reverts below it.
 *
 * The RHC Universal Router runs a V4Router whose ExactInputSingleParams carries `minHopPriceX36` between
 * amountOutMinimum and hookData (v4-periphery IV4Router.sol; the 5-field encoding reverts). 0 = off.
 */
import { concatHex, encodeAbiParameters, encodeFunctionData, encodePacked, type Hex } from "viem";
import { universalRouterAbi } from "./abis.js";
import { NATIVE, type Address } from "./chain.js";
import type { PoolKey } from "./pool.js";

export type Hop =
  | { venue: "v3"; pool: Address; tokenIn: Address; tokenOut: Address; fee: number }
  | { venue: "v4"; poolId: Hex; key: PoolKey; zeroForOne: boolean };

export interface Leg {
  /** Share of the input in basis points (10,000 = all). */
  shareBps: number;
  amountIn: string;
  amountOut: string;
  hops: Hop[];
}

export const MAX_INTEGRATOR_FEE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 300;
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Universal Router command bytes used by this encoder. */
export const CMD = {
  V3_SWAP_EXACT_IN: 0x00,
  PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04,
  PAY_PORTION: 0x06,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;
/** V4Router action bytes used by this encoder. */
export const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, TAKE: 0x0e } as const;
export const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
export const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
export const CONTRACT_BALANCE = 1n << 255n;

const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const exactInSingle = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

const lc = (a: string) => a.toLowerCase();
const isEth = (a: string) => lc(a) === NATIVE;

/** Currency a hop consumes / produces, in the form the venue needs (v3 = WETH for ETH, v4 = the key's currency). */
export function hopIn(h: Hop): Address {
  return h.venue === "v3" ? h.tokenIn : h.zeroForOne ? h.key.currency0 : h.key.currency1;
}
export function hopOut(h: Hop): Address {
  return h.venue === "v3" ? h.tokenOut : h.zeroForOne ? h.key.currency1 : h.key.currency0;
}

export interface BuildParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  legs: { amountIn: bigint; hops: Hop[] }[];
  minOut: bigint;
  weth: Address;
  feeBps?: number;
  feeRecipient?: Address;
  deadline: bigint;
}

/** Universal Router `execute` calldata + msg.value for a route. Throws on a route it cannot encode safely. */
export function buildExecute(p: BuildParams): { data: Hex; value: bigint; commands: string[] } {
  const cmds: number[] = [];
  const inputs: Hex[] = [];
  const names: string[] = [];
  const push = (c: number, name: string, input: Hex) => {
    cmds.push(c);
    inputs.push(input);
    names.push(name);
  };
  const weth = lc(p.weth);
  const sum = p.legs.reduce((s, l) => s + l.amountIn, 0n);
  if (sum !== p.amountIn) throw new Error("leg amounts must add up to amountIn");
  if (p.legs.length > 1 && p.legs.some((l) => l.hops.length > 1))
    throw new Error("split routes are single-hop per leg");
  if (lc(p.tokenIn) === weth && p.legs.some((l) => isEth(hopIn(l.hops[0]))))
    throw new Error("WETH input cannot enter a native-ETH pool in a split");
  const fee = p.feeBps ?? 0;
  if (fee < 0 || fee > MAX_INTEGRATOR_FEE_BPS)
    throw new Error(`integrator fee is capped at ${MAX_INTEGRATOR_FEE_BPS} bps`);

  const ethIn = isEth(p.tokenIn);
  if (!ethIn)
    push(
      CMD.PERMIT2_TRANSFER_FROM,
      "PERMIT2_TRANSFER_FROM",
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint160" }],
        [p.tokenIn, ADDRESS_THIS, p.amountIn],
      ),
    );

  for (const leg of p.legs) {
    let cur = lc(p.tokenIn);
    leg.hops.forEach((h, i) => {
      const need = lc(hopIn(h));
      const amt = i === 0 ? leg.amountIn : CONTRACT_BALANCE;
      if (need !== cur) {
        if (isEth(cur) && need === weth)
          push(
            CMD.WRAP_ETH,
            "WRAP_ETH",
            encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, amt]),
          );
        else if (cur === weth && isEth(need)) {
          if (i === 0 && p.legs.length > 1) throw new Error("cannot unwrap a partial WETH balance");
          push(
            CMD.UNWRAP_WETH,
            "UNWRAP_WETH",
            encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, 0n]),
          );
        } else throw new Error(`hop ${i + 1} expects ${need}, router holds ${cur}`);
      }
      if (h.venue === "v3") {
        const path = encodePacked(["address", "uint24", "address"], [h.tokenIn, h.fee, h.tokenOut]);
        // RHC router: (recipient, amountIn, amountOutMin, path, payerIsUser, uint256[] minHopPriceX36) — the 6th field
        // was read off a live router tx (0x9953bd1f…); the 5-field encoding reverts with SliceOutOfBounds().
        push(
          CMD.V3_SWAP_EXACT_IN,
          "V3_SWAP_EXACT_IN",
          encodeAbiParameters(
            [
              { type: "address" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "bytes" },
              { type: "bool" },
              { type: "uint256[]" },
            ],
            [ADDRESS_THIS, amt, 0n, path, false, []],
          ),
        );
      } else {
        const cin = hopIn(h);
        const cout = hopOut(h);
        const actions = encodePacked(["uint8", "uint8", "uint8"], [ACT.SETTLE, ACT.SWAP_EXACT_IN_SINGLE, ACT.TAKE]);
        const params = [
          encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [cin, amt, false]),
          encodeAbiParameters(exactInSingle, [
            {
              poolKey: h.key,
              zeroForOne: h.zeroForOne,
              amountIn: 0n,
              amountOutMinimum: 0n,
              minHopPriceX36: 0n,
              hookData: "0x",
            },
          ]),
          encodeAbiParameters(
            [{ type: "address" }, { type: "address" }, { type: "uint256" }],
            [cout, ADDRESS_THIS, 0n],
          ),
        ];
        push(CMD.V4_SWAP, "V4_SWAP", encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]));
      }
      cur = lc(hopOut(h));
    });
  }

  // Bring every leg's output to the asked-for form.
  const outs = new Set(p.legs.map((l) => lc(hopOut(l.hops[l.hops.length - 1]))));
  const want = lc(p.tokenOut);
  if (isEth(want) && outs.has(weth))
    push(
      CMD.UNWRAP_WETH,
      "UNWRAP_WETH",
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, 0n]),
    );
  if (want === weth && outs.has(NATIVE))
    push(
      CMD.WRAP_ETH,
      "WRAP_ETH",
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, CONTRACT_BALANCE]),
    );
  for (const o of outs)
    if (o !== want && !((o === weth && isEth(want)) || (isEth(o) && want === weth)))
      throw new Error(`a leg ends in ${o}, not ${want}`);

  if (fee > 0) {
    if (!p.feeRecipient || !/^0x[0-9a-fA-F]{40}$/.test(p.feeRecipient))
      throw new Error("feeRecipient required with feeBps");
    push(
      CMD.PAY_PORTION,
      "PAY_PORTION",
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        [p.tokenOut, p.feeRecipient, BigInt(fee)],
      ),
    );
  }
  push(
    CMD.SWEEP,
    "SWEEP",
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [p.tokenOut, MSG_SENDER, p.minOut],
    ),
  );

  const commands = concatHex(cmds.map((c) => `0x${c.toString(16).padStart(2, "0")}` as Hex));
  return {
    data: encodeFunctionData({
      abi: universalRouterAbi,
      functionName: "execute",
      args: [commands, inputs, p.deadline],
    }),
    value: ethIn ? p.amountIn : 0n,
    commands: names,
  };
}

/**
 * Integrator fee and guaranteed minimum for a quoted output (same arithmetic as the Zerohook app):
 * fee = out × feeBps / 10,000; minOut = (out − fee) × (10,000 − slippageBps) / 10,000, both rounded down.
 */
export function minOutFor(amountOut: bigint, feeBps: number, slippageBps: number) {
  const fee = (amountOut * BigInt(feeBps)) / 10_000n;
  const afterFee = amountOut - fee;
  const minOut = (afterFee * BigInt(10_000 - slippageBps)) / 10_000n;
  return { fee, afterFee, minOut };
}
