# @zhooktrade/sdk

Best-price routing on **Robinhood Chain** (chain id 4663), extracted from the engine behind the [Zerohook](https://zerohook.trade) app.

- Quotes across **Uniswap v3** (all four fee tiers), **Uniswap v4** and **hooked v4 pools**, then picks the best of a single pool, a **two-way split** or a **two-hop route** through USDG or ETH.
- Builds **Universal Router calldata through Permit2**, including the extra `minHopPriceX36` field the Robinhood Chain router expects in v4 and v3 swap inputs.
- **Hard limits** before any calldata: slippage cap, guaranteed minimum (enforced on-chain by `SWEEP`), integrator fee cap, optional price-impact and minimum-received limits.
- **Pinned code hashes** for the router, Permit2, the v4 PoolManager, quoters, the v3 factory, WETH9 and USDG, plus a code check of every hook in the route.
- **`eth_call` simulation** (and gas estimate) from the signing wallet before it signs.
- **USD prices**, verified **Robinhood Stock Tokens** and **Hook Passports**.

Read-only. The SDK never holds a key, signs or sends: it returns calldata for your own wallet to sign.

Links: app [app.zerohook.trade](https://app.zerohook.trade) · docs [docs.zerohook.trade](https://docs.zerohook.trade) · site [zerohook.trade](https://zerohook.trade) (currently served at [preview.zerohook.trade](https://preview.zerohook.trade)).

## Install

```sh
git clone https://github.com/zhooktrade/zhook-sdk.git
cd zhook-sdk
pnpm install
pnpm build
```

Then depend on it from a sibling project:

```json
{ "dependencies": { "@zhooktrade/sdk": "file:../zhook-sdk" } }
```

Requires Node 20 or later. ESM only. [viem](https://viem.sh) is the only runtime dependency.

## Usage

```ts
import { createZhook, RHC } from "@zhooktrade/sdk";

const zhook = createZhook(); // public RPCs; or createZhook({ rpcUrls: ["https://…"] })

const quote = await zhook.quote({
  tokenIn: "ETH", // or a token address
  tokenOut: RHC.usdg,
  amount: "0.25", // decimal, in tokenIn units
  slippageBps: 50, // 1–300
  from: "0xYourWallet", // optional: simulate the calldata from this wallet
  maxPriceImpactPct: 1, // optional hard limit
});

console.log(quote.kind, quote.amountOut, quote.minOut, quote.priceImpactPct);
console.log(quote.legs); // venues and amounts per leg
console.log(quote.warnings, quote.blocked);

if (quote.tx) {
  // quote.tx = { to: Universal Router, data, value, commands, deadline }
  // Send it with your own wallet client, for example viem's walletClient.sendTransaction(...)
}
```

### ERC-20 input

ERC-20 input goes through Permit2: the token needs an allowance to Permit2, and Permit2 needs an allowance to the Universal Router.

```ts
const status = await zhook.approvalStatus(wallet, token, amountRaw);
// status.missing: ("balance" | "erc20-approve-permit2" | "permit2-approve-router")[]

const [approvePermit2, approveRouter] = zhook.approvalTxs(token, { amount: amountRaw }); // unsigned calldata; unlimited without amount
```

### Simulate before signing

```ts
const sim = await zhook.simulate({ from: wallet, to: quote.tx.to, data: quote.tx.data, value: BigInt(quote.tx.value) });
// { ok, gasEstimate, error, overridden }

// Dry run from an empty wallet (native ETH input): fund it through a state override.
await zhook.simulate({ from: anyAddress, to, data, value, fundEth: true });
```

### Prices, Stock Tokens, hooks and pools

```ts
await zhook.price("ETH"); // { priceUsd, via: "usdg" | "eth" | "par", venue, block }
await zhook.prices([RHC.usdg, "0x…"]);

await zhook.stockTokens(); // Robinhood Stock Tokens, verified by exact proxy code
await zhook.isStockToken("0x…");

await zhook.hookPassport("0xHook"); // permissions, proxy, owner, source, risk score
zhook.registry.hooks(); // hooks in the pool list, most swaps first
await zhook.poolState(poolId); // live slot0, liquidity, token metadata
```

### Calldata without a quote

The encoder is a pure function. Give it a route and it returns the exact `execute(commands, inputs, deadline)` calldata:

```ts
import { buildExecute, poolIdOf, NATIVE, RHC } from "@zhooktrade/sdk";

const key = { currency0: NATIVE, currency1: RHC.usdg, fee: 500, tickSpacing: 10, hooks: NATIVE };
const { data, value, commands } = buildExecute({
  tokenIn: NATIVE,
  tokenOut: RHC.usdg,
  amountIn: 10n ** 17n,
  legs: [{ amountIn: 10n ** 17n, hops: [{ venue: "v4", poolId: poolIdOf(key), key, zeroForOne: true }] }],
  minOut: 250_000_000n,
  weth: RHC.weth,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
});
// commands: ["V4_SWAP", "SWEEP"]
```

## Pool list

v3 pools are resolved live from the factory for every fee tier. v4 pools are keyed by `(currency0, currency1, fee, tickSpacing, hooks)` and cannot be listed cheaply on-chain, so the router routes over a **pool list**:

- **Default set** (bundled): every pool pairing two of ETH / WETH / USDG, the three most-traded pools of each verified Stock Token and the 120 most-traded pools, from a full scan at block `DEFAULT_POOLS_BLOCK`. Only keys, codehash pins of their hooks and ranking weights are bundled; prices and liquidity are always read live.
- **Your own pools**: `createZhook({ pools: [{ key, swaps, liquidity }] })`, or a full `PoolRegistry`.
- **Discovery**: `await zhook.discoverPools({ blocks: 20_000 })` scans recent PoolManager `Initialize` logs and adds what it finds. `registry.toRows()` gives compact rows to persist.

```ts
import { createZhook, PoolRegistry } from "@zhooktrade/sdk";

const registry = new PoolRegistry({ includeDefaults: true, pools: savedRows });
const zhook = createZhook({ registry });
await zhook.discoverPools({ blocks: 20_000 });
```

## API

| Export                                                                    | What it does                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createZhook(options)` / `new Zhook(options)`                             | Router bound to a viem client and a pool registry. Options: `client`, `rpcUrls`, `registry`, `pools`, `includeDefaultPools`, `now`.                                                                                                 |
| `zhook.quote(params)`                                                     | Best route + limits + pin and hook checks + calldata. Params: `tokenIn`, `tokenOut`, `amount`, `slippageBps`, `feeBps`, `feeRecipient`, `from`, `hooks`, `deadlineSeconds`, `maxPriceImpactPct`, `minAmountOut`, `pinnedHooksOnly`. |
| `zhook.quoteAt(block, params)`                                            | Same at a past block (needs an archive RPC).                                                                                                                                                                                        |
| `zhook.simulate(params)`                                                  | `eth_call` + `eth_estimateGas` from a wallet, optional state override.                                                                                                                                                              |
| `zhook.approvalStatus(owner, token, amount)` / `zhook.approvalTxs(token)` | Permit2 allowance check and approval calldata.                                                                                                                                                                                      |
| `zhook.checkPins()`                                                       | Re-read every pinned contract and compare its codehash.                                                                                                                                                                             |
| `zhook.price(token)` / `zhook.prices(tokens)`                             | USD per whole token from live Uniswap quotes (USDG = 1).                                                                                                                                                                            |
| `zhook.stockTokens()` / `zhook.isStockToken(addr)`                        | Robinhood Stock Tokens by exact proxy codehash.                                                                                                                                                                                     |
| `zhook.hookPassport(hook)`                                                | Hook permissions, proxy, owner, Sourcify status, bytecode scan and a rule-based risk score.                                                                                                                                         |
| `zhook.poolState(poolId)`                                                 | Live v4 pool state.                                                                                                                                                                                                                 |
| `zhook.discoverPools(options)`                                            | Add pools from recent `Initialize` logs.                                                                                                                                                                                            |
| `buildExecute(params)`                                                    | Universal Router calldata for a route (pure).                                                                                                                                                                                       |
| `minOutFor(out, feeBps, slippageBps)`                                     | Integrator fee and guaranteed minimum.                                                                                                                                                                                              |
| `PoolRegistry`, `discoverPools`, `decodeInitialize`                       | Pool list management.                                                                                                                                                                                                               |
| `checkPins`, `PINS`, `codehashOf`                                         | Pinned contracts.                                                                                                                                                                                                                   |
| `decodeFlags`, `FLAGS`, `evaluatePassport`, `scanBytecode`                | Hook permission bits and passport rules.                                                                                                                                                                                            |
| `createClient`, `getLogsChunked`, `RHC`                                   | Robinhood Chain client, chunked log reads, addresses.                                                                                                                                                                               |

`QuoteResponse` fields worth checking before signing: `pinsOk`, `hooks[].status` (`match`, `changed`, `new`, `no-code`), `warnings`, `blocked`, `simulation`, `txNote`.

## Limits

| Limit              | Value                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| Slippage           | 1–300 bps (`MAX_SLIPPAGE_BPS`), default 50                                           |
| Integrator fee     | 0–50 bps (`MAX_INTEGRATOR_FEE_BPS`), paid with `PAY_PORTION` before `SWEEP`          |
| Guaranteed minimum | `SWEEP(tokenOut, msg.sender, minOut)`: the whole transaction reverts below it        |
| Pinned contracts   | any codehash mismatch withholds calldata                                             |
| Optional           | `maxPriceImpactPct`, `minAmountOut`, `pinnedHooksOnly` withhold calldata when broken |
| Deadline           | 20 minutes by default (`deadlineSeconds`)                                            |

Known boundaries:

- Exact-input swaps only. Splits are two legs of one hop each; multi-hop routes are one leg of two hops through USDG or ETH.
- A WETH input cannot enter a native-ETH v4 pool (the router cannot unwrap part of a balance); such routes get no calldata.
- Each v4 pair is quoted over at most the 10 deepest unhooked and the 8 most-used hooked pools in the pool list.
- Price impact is measured against the same route at 1/1000 size.
- Public RPCs rate-limit. Pass your own `rpcUrls` for heavy use.

## Tests

```sh
pnpm test                      # unit tests and golden vectors, offline
RPC_URL=https://robinhood-rpc.publicnode.com pnpm test:live   # live checks on Robinhood Chain
```

- `test/vectors/encoder.json`: routes and the exact calldata the Zerohook app's encoder produced for them (v3, v4, hooked, splits, two-hop, wrap/unwrap, integrator fee, and the routes it refuses). The SDK must match byte for byte.
- `test/vectors/app-quotes.json`: quotes returned by the live app; rebuilding each route with the SDK must give the same calldata and minimum.
- The quote engine, limits, registry, discovery, passport rules and simulation run against a deterministic in-memory chain.

## License

MIT © Zerohook
