export { Zhook, createZhook, type ZhookOptions } from "./zhook.js";
export {
  RHC,
  NATIVE,
  V3_FEES,
  DYNAMIC_FEE_FLAG,
  EIP1967_IMPL_SLOT,
  explorerAddress,
  explorerTx,
  type Address,
  type ChainConfig,
} from "./chain.js";
export * from "./abis.js";
export { ZhookError } from "./errors.js";
export {
  createClient,
  viemChain,
  rawRpc,
  getLogsChunked,
  type ClientOptions,
  type LogsOptions,
  type RawLog,
} from "./rpc.js";
export { PINS, USDG_IMPL, checkPins, codehashOf, type Pin, type PinCheck } from "./pins.js";
export {
  poolIdOf,
  priceFromSqrt,
  feeLabel,
  isHooked,
  readPoolState,
  type PoolKey,
  type PoolState,
  type TokenMeta,
} from "./pool.js";
export {
  buildExecute,
  hopIn,
  hopOut,
  minOutFor,
  CMD,
  ACT,
  MSG_SENDER,
  ADDRESS_THIS,
  CONTRACT_BALANCE,
  MAX_INTEGRATOR_FEE_BPS,
  MAX_SLIPPAGE_BPS,
  DEFAULT_SLIPPAGE_BPS,
  type Hop,
  type Leg,
  type BuildParams,
} from "./route.js";
export {
  PoolRegistry,
  defaultRegistry,
  rowToInput,
  inputToRow,
  type PoolRow,
  type PoolInput,
  type RegistryPool,
  type RegistryOptions,
  type HookPin,
  type HookSummary,
} from "./registry.js";
export { DEFAULT_POOL_ROWS, DEFAULT_POOLS_BLOCK, DEFAULT_POOLS_DATE } from "./data/pools.js";
export { STOCK_CANDIDATES } from "./data/stocks.js";
export {
  discoverPools,
  decodeInitialize,
  type DiscoverOptions,
  type DiscoverResult,
  type DiscoveredPool,
} from "./discover.js";
export {
  quoteRoute,
  parseLimits,
  type QuoteParams,
  type QuoteResponse,
  type TokenInfo,
  type HookCheck,
  type CandidateView,
  type SwapTx,
  type Candidate,
  type EngineContext,
} from "./quote.js";
export {
  simulateTx,
  approvalStatus,
  approvalTxs,
  type Simulation,
  type SimulateParams,
  type ApprovalStatus,
  type UnsignedTx,
} from "./simulate.js";
export { STOCK_BEACON, STOCK_PROXY_CODEHASH, type PriceQuote, type StockToken, type StockTokenList } from "./market.js";
export { buildPassport, scanBytecode, minimalProxyTarget, type PassportOptions } from "./passport.js";
export {
  evaluate as evaluatePassport,
  DISCLAIMER,
  RATING_LABEL,
  PRIVILEGED_SIGNATURES,
  type Passport,
  type PassportFacts,
  type PoolSeen,
  type RuleHit,
  type RuleLevel,
} from "./passport-rules.js";
export {
  FLAGS,
  ALL_HOOK_MASK,
  decodeFlags,
  flagByKey,
  invalidDeltaPairs,
  maskOf,
  maskHex,
  maskBinary,
  type FlagKey,
  type FlagDef,
  type Impact,
} from "./permissions.js";
export { TtlCache } from "./cache.js";
