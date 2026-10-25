/**
 * Pinned contracts: keccak256 of each contract's runtime bytecode on Robinhood Chain, computed with eth_getCode at
 * `latest` on 2026-10-25 (block ~97.45M). Before quoting, the code is re-read and compared; any mismatch marks the
 * quote unsafe to sign. USDG is a proxy: its pinned hash covers the proxy code and the implementation slot is pinned
 * separately.
 */
import { keccak256, type PublicClient } from "viem";
import { EIP1967_IMPL_SLOT, RHC, type Address } from "./chain.js";

export interface Pin {
  name: string;
  address: Address;
  size: number;
  codehash: `0x${string}`;
  role: string;
}

export interface PinCheck {
  name: string;
  address: Address;
  ok: boolean;
  expected: string;
  actual: string | null;
}

export const PINS: Pin[] = [
  {
    name: "Universal Router",
    address: "0x8876789976decbfcbbbe364623c63652db8c0904",
    size: 24546,
    codehash: "0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde",
    role: "Executes every route",
  },
  {
    name: "Permit2",
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    size: 9152,
    codehash: "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca",
    role: "Token approvals for the router",
  },
  {
    name: "v4 PoolManager",
    address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    size: 24009,
    codehash: "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626",
    role: "Holds every v4 pool",
  },
  {
    name: "v4 Quoter",
    address: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    size: 6118,
    codehash: "0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6",
    role: "v4 quotes (incl. hooked pools)",
  },
  {
    name: "v4 StateView",
    address: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    size: 3531,
    codehash: "0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6",
    role: "v4 pool price and liquidity",
  },
  {
    name: "v3 QuoterV2",
    address: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    size: 8273,
    codehash: "0x3db0868d945e9304c9bc6a8b2181948109ea617647142f3c4083e14393496a28",
    role: "v3 quotes",
  },
  {
    name: "v3 Factory",
    address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    size: 24535,
    codehash: "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739",
    role: "Resolves v3 pools",
  },
  {
    name: "WETH9",
    address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    size: 2202,
    codehash: "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353",
    role: "Wrapped ETH",
  },
  {
    name: "USDG (proxy)",
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    size: 170,
    codehash: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
    role: "Stablecoin, 6 decimals",
  },
];

/** USDG's EIP-1967 implementation slot value at pin time. */
export const USDG_IMPL = "0x68184c449e1a8f34fa18d289737129fd27b66f8f";

/** Codehash of runtime code, null when the address has none. */
export const codehashOf = (code: `0x${string}` | undefined | null): `0x${string}` | null =>
  code && code !== "0x" ? keccak256(code) : null;

/** Re-read every pinned contract's code (and USDG's implementation slot) and compare it with the pin. */
export async function checkPins(client: PublicClient): Promise<PinCheck[]> {
  const [codes, impl] = await Promise.all([
    Promise.all(PINS.map((p) => client.getCode({ address: p.address }).catch(() => undefined))),
    client.getStorageAt({ address: RHC.usdg, slot: EIP1967_IMPL_SLOT }).catch(() => undefined),
  ]);
  const checks: PinCheck[] = PINS.map((p, i) => {
    const actual = codehashOf(codes[i]);
    return { name: p.name, address: p.address, ok: actual === p.codehash, expected: p.codehash, actual };
  });
  const implNow = impl ? ("0x" + impl.slice(-40)).toLowerCase() : null;
  checks.push({
    name: "USDG implementation slot",
    address: RHC.usdg,
    ok: implNow === USDG_IMPL,
    expected: USDG_IMPL,
    actual: implNow,
  });
  return checks;
}
