export interface ChainConfig {
  name: string;
  chain: string;
  version: "v3" | "v4";
  subgraphId: string;
  description: string;
  keyEntities: string[];
}

// Uniswap V3 subgraph IDs from official Uniswap docs:
// https://docs.uniswap.org/api/subgraph/overview
//
// Uniswap V4 subgraph IDs from Graph Explorer and Uniswap docs.
//
// V3 schema: Factory, Pool, Token, Swap, Mint, Burn, Collect, Flash,
//   Tick, Transaction, UniswapDayData, PoolDayData, PoolHourData,
//   TokenDayData, TokenHourData, Bundle
//
// V4 schema: PoolManager (replaces Factory), Pool (adds hooks, tickSpacing,
//   isExternalLiquidity), Token, Swap, ModifyLiquidity (replaces Mint/Burn),
//   Position, Subscribe, Unsubscribe, Transfer, Tick, Transaction,
//   UniswapDayData, PoolDayData, PoolHourData, TokenDayData, TokenHourData, Bundle
//
// V3 amount fields: raw BigDecimal (already human-readable, NOT raw uint256)
// V3 price fields: token0Price/token1Price are human-readable decimals
// V3 feeTier: integer in hundredths of a bip (e.g., 3000 = 0.30%, 500 = 0.05%, 10000 = 1%)

export const CHAINS: Record<string, ChainConfig> = {
  // ── V3 ──────────────────────────────────────────────────────────────────
  "ethereum-v3": {
    name: "Uniswap V3 Ethereum",
    chain: "Ethereum",
    version: "v3",
    subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    description:
      "Uniswap V3 on Ethereum mainnet. The original and most liquid V3 deployment. " +
      "Deep ETH/USDC, ETH/USDT, WBTC/ETH pools. ~27.9M queries/30d.",
    keyEntities: [
      "pool (token0, token1, feeTier, liquidity, sqrtPrice, token0Price, token1Price, totalValueLockedUSD, volumeUSD, feesUSD, txCount)",
      "swap (sender, recipient, amount0, amount1, amountUSD, sqrtPriceX96, tick, timestamp)",
      "mint (owner, amount, amount0, amount1, amountUSD, tickLower, tickUpper)",
      "burn (owner, amount, amount0, amount1, amountUSD, tickLower, tickUpper)",
      "token (symbol, name, decimals, volume, volumeUSD, totalValueLocked, totalValueLockedUSD, derivedETH)",
    ],
  },
  "base-v3": {
    name: "Uniswap V3 Base",
    chain: "Base",
    version: "v3",
    subgraphId: "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG",
    description:
      "Uniswap V3 on Base (Coinbase L2). Fast-growing deployment. " +
      "Strong USDC, cbETH, and DEGEN liquidity. ~13.1M queries/30d.",
    keyEntities: [
      "pool / swap / mint / burn / token (same schema as Ethereum V3)",
    ],
  },
  "arbitrum-v3": {
    name: "Uniswap V3 Arbitrum",
    chain: "Arbitrum",
    version: "v3",
    subgraphId: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM",
    description:
      "Uniswap V3 on Arbitrum. Major L2 deployment with deep ARB ecosystem liquidity.",
    keyEntities: [
      "pool / swap / mint / burn / token (same schema as Ethereum V3)",
    ],
  },
  "polygon-v3": {
    name: "Uniswap V3 Polygon",
    chain: "Polygon",
    version: "v3",
    subgraphId: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
    description:
      "Uniswap V3 on Polygon. Established deployment with MATIC and stablecoin liquidity.",
    keyEntities: [
      "pool / swap / mint / burn / token (same schema as Ethereum V3)",
    ],
  },
  "optimism-v3": {
    name: "Uniswap V3 Optimism",
    chain: "Optimism",
    version: "v3",
    subgraphId: "Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj",
    description:
      "Uniswap V3 on Optimism. OP ecosystem DEX trading.",
    keyEntities: [
      "pool / swap / mint / burn / token (same schema as Ethereum V3)",
    ],
  },

  // ── V4 ──────────────────────────────────────────────────────────────────
  "ethereum-v4": {
    name: "Uniswap V4 Ethereum",
    chain: "Ethereum",
    version: "v4",
    subgraphId: "DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G",
    description:
      "Uniswap V4 on Ethereum mainnet. Singleton PoolManager contract with hooks support. " +
      "New architecture with customizable pool logic.",
    keyEntities: [
      "pool (token0, token1, feeTier, tickSpacing, hooks, liquidity, sqrtPrice, token0Price, token1Price, totalValueLockedUSD, volumeUSD, isExternalLiquidity)",
      "swap (sender, amount0, amount1, amountUSD, sqrtPriceX96, tick, timestamp)",
      "modifyLiquidity (sender, amount, amount0, amount1, amountUSD, tickLower, tickUpper)",
      "position (tokenId, owner, origin)",
      "token (symbol, name, decimals, volume, volumeUSD, totalValueLocked, totalValueLockedUSD, derivedETH)",
    ],
  },
  "base-v4": {
    name: "Uniswap V4 Base",
    chain: "Base",
    version: "v4",
    subgraphId: "2L6yxqUZ7dT6GWoTy9qxNBkf9kEk65me3XPMvbGsmJUZ",
    description:
      "Uniswap V4 on Base. Highest query volume V4 deployment (~246.6M queries/30d). " +
      "Hooks-enabled pools on Coinbase L2.",
    keyEntities: [
      "pool / swap / modifyLiquidity / position / token (same schema as Ethereum V4)",
    ],
  },
  "arbitrum-v4": {
    name: "Uniswap V4 Arbitrum",
    chain: "Arbitrum",
    version: "v4",
    subgraphId: "G5TsTKNi8yhPSV7kycaE23oWbqv9zzNqR49FoEQjzq1r",
    description:
      "Uniswap V4 on Arbitrum. V4 hooks-enabled pools on Arbitrum.",
    keyEntities: [
      "pool / swap / modifyLiquidity / position / token (same schema as Ethereum V4)",
    ],
  },
  "polygon-v4": {
    name: "Uniswap V4 Polygon",
    chain: "Polygon",
    version: "v4",
    subgraphId: "CwpebM66AH5uqS5sreKij8yEkkPcHvmyEs7EwFtdM5ND",
    description:
      "Uniswap V4 on Polygon. V4 hooks-enabled pools on Polygon.",
    keyEntities: [
      "pool / swap / modifyLiquidity / position / token (same schema as Ethereum V4)",
    ],
  },
  // Note: V4 Optimism subgraph not yet published to the decentralized network
};

export const CHAIN_NAMES = Object.keys(CHAINS) as [string, ...string[]];

export const V3_CHAIN_NAMES = Object.keys(CHAINS).filter(
  (k) => CHAINS[k].version === "v3"
) as [string, ...string[]];

export const V4_CHAIN_NAMES = Object.keys(CHAINS).filter(
  (k) => CHAINS[k].version === "v4"
) as [string, ...string[]];

/** Map a simple chain name (e.g. "ethereum") to all matching chain keys */
export function getChainKeys(chain: string): string[] {
  const normalized = chain.toLowerCase();
  return Object.keys(CHAINS).filter((k) => {
    const cfg = CHAINS[k];
    return cfg.chain.toLowerCase() === normalized;
  });
}

/** Get a chain config, throwing a helpful error if not found */
export function getChainConfig(chainKey: string): ChainConfig {
  const cfg = CHAINS[chainKey];
  if (!cfg) {
    const available = Object.keys(CHAINS).join(", ");
    throw new Error(
      `Unknown chain "${chainKey}". Available chains: ${available}`
    );
  }
  return cfg;
}
