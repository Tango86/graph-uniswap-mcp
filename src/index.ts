#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { querySubgraph } from "./graphClient.js";
import {
  CHAINS,
  CHAIN_NAMES,
  V3_CHAIN_NAMES,
  V4_CHAIN_NAMES,
  getChainConfig,
  getChainKeys,
} from "./subgraphs.js";

const server = new McpServer({
  name: "graph-uniswap-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

function formatFeeTier(feeTier: string | number): string {
  const tier = Number(feeTier);
  if (tier === 100) return "0.01%";
  if (tier === 500) return "0.05%";
  if (tier === 3000) return "0.30%";
  if (tier === 10000) return "1.00%";
  return (tier / 10000).toFixed(2) + "%";
}

function formatUSD(value: string | number): string {
  const n = Number(value);
  if (isNaN(n)) return String(value);
  if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  return "$" + n.toFixed(2);
}

function formatNumber(value: string | number): string {
  const n = Number(value);
  if (isNaN(n)) return String(value);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + "K";
  if (Math.abs(n) >= 1) return n.toFixed(4);
  if (Math.abs(n) >= 0.0001) return n.toFixed(6);
  return n.toFixed(8);
}

function formatTimestamp(ts: string | number): string {
  return new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function annotatePools(pools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return pools.map((pool) => {
    const hr: Record<string, unknown> = {};
    const t0 = pool.token0 as Record<string, unknown> | undefined;
    const t1 = pool.token1 as Record<string, unknown> | undefined;
    hr.pair = `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`;
    if (pool.feeTier) hr.feeTier = formatFeeTier(pool.feeTier as string);
    if (pool.totalValueLockedUSD) hr.tvl = formatUSD(pool.totalValueLockedUSD as string);
    if (pool.volumeUSD) hr.totalVolume = formatUSD(pool.volumeUSD as string);
    if (pool.feesUSD) hr.totalFees = formatUSD(pool.feesUSD as string);
    if (pool.token0Price) hr.token0Price = formatNumber(pool.token0Price as string);
    if (pool.token1Price) hr.token1Price = formatNumber(pool.token1Price as string);
    if (pool.txCount) hr.txCount = formatNumber(pool.txCount as string);
    if (pool.hooks !== undefined) hr.hooks = pool.hooks;
    pool._humanReadable = hr;
    return pool;
  });
}

// ---------------------------------------------------------------------------
// Tool 1: list_uniswap_chains
// ---------------------------------------------------------------------------
server.registerTool(
  "list_uniswap_chains",
  {
    description:
      "List all supported Uniswap chains and their subgraph configurations. " +
      "Use this to discover which chains and Uniswap versions (V3, V4) are available. " +
      "Call this first when unsure which chain key to use for other tools.",
  },
  async () => {
    try {
      const chains = Object.entries(CHAINS).map(([key, cfg]) => ({
        chainKey: key,
        name: cfg.name,
        chain: cfg.chain,
        version: cfg.version,
        description: cfg.description,
      }));
      return textResult({ chains, totalChains: chains.length });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2: get_protocol_stats
// ---------------------------------------------------------------------------
server.registerTool(
  "get_protocol_stats",
  {
    description:
      "Get global Uniswap protocol statistics for a specific chain and version: " +
      "total pools, transaction count, total volume, total fees, TVL, and current ETH price in USD. " +
      "V3 uses 'factories' entity, V4 uses 'poolManagers' entity. " +
      "Example: 'What is the total TVL on Uniswap V3 Ethereum?'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe(
        "Chain key (e.g., 'ethereum-v3', 'base-v4'). Use list_uniswap_chains to see all options."
      ),
    },
  },
  async ({ chain }) => {
    try {
      const cfg = getChainConfig(chain);
      let query: string;

      if (cfg.version === "v4") {
        query = `{
          poolManagers(first: 1) {
            id
            poolCount
            txCount
            totalVolumeUSD
            totalVolumeETH
            totalFeesUSD
            totalFeesETH
            totalValueLockedUSD
            totalValueLockedETH
          }
          bundle(id: "1") { ethPriceUSD }
        }`;
      } else {
        query = `{
          factories(first: 1) {
            id
            poolCount
            txCount
            totalVolumeUSD
            totalVolumeETH
            totalFeesUSD
            totalFeesETH
            totalValueLockedUSD
            totalValueLockedETH
          }
          bundle(id: "1") { ethPriceUSD }
        }`;
      }

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const stats = cfg.version === "v4"
        ? (data.poolManagers as unknown[])?.[0]
        : (data.factories as unknown[])?.[0];
      const bundle = data.bundle as Record<string, unknown> | undefined;

      const result: Record<string, unknown> = {
        chain: cfg.name,
        version: cfg.version,
        stats,
        ethPriceUSD: bundle?.ethPriceUSD,
      };

      if (stats && typeof stats === "object") {
        const s = stats as Record<string, unknown>;
        // Clamp negative TVL (known V4 subgraph accounting issue)
        const rawTvl = Number(s.totalValueLockedUSD ?? 0);
        const tvl = rawTvl < 0 ? 0 : rawTvl;
        if (rawTvl < 0) {
          s.totalValueLockedUSD = "0";
          s._tvlNote = "TVL data unavailable (subgraph reports negative value)";
        }
        result._humanReadable = {
          totalPools: formatNumber(s.poolCount as string),
          totalVolume: formatUSD(s.totalVolumeUSD as string),
          totalFees: formatUSD(s.totalFeesUSD as string),
          tvl: rawTvl < 0 ? "N/A (data unavailable)" : formatUSD(tvl),
          ethPrice: formatUSD(bundle?.ethPriceUSD as string),
        };
      }

      return textResult(result);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 3: get_top_pools
// ---------------------------------------------------------------------------
server.registerTool(
  "get_top_pools",
  {
    description:
      "Get the top Uniswap pools ranked by TVL, volume, or fees. " +
      "Returns pool pairs, fee tiers, TVL, volume, fees, prices, and transaction counts. " +
      "Use this to discover the most active or liquid pools on a chain. " +
      "Example: 'Show me the top 10 pools on Base V4 by volume'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key (e.g., 'ethereum-v3', 'base-v4')"),
      orderBy: z.enum(["totalValueLockedUSD", "volumeUSD", "feesUSD", "txCount"])
        .default("totalValueLockedUSD")
        .describe("Field to sort by. Defaults to TVL."),
      limit: z.number().min(1).max(100).default(10).describe("Number of pools to return (1-100)"),
    },
  },
  async ({ chain, orderBy, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const hooksField = cfg.version === "v4" ? "hooks\n        tickSpacing" : "";
      const query = `{
        pools(
          first: ${limit}
          orderBy: ${orderBy}
          orderDirection: desc
          where: { totalValueLockedUSD_gt: "100", txCount_gt: "100", volumeUSD_gt: "1000" }
        ) {
          id
          token0 { id symbol name decimals }
          token1 { id symbol name decimals }
          feeTier
          liquidity
          sqrtPrice
          token0Price
          token1Price
          totalValueLockedUSD
          totalValueLockedToken0
          totalValueLockedToken1
          volumeUSD
          feesUSD
          txCount
          ${hooksField}
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const pools = annotatePools((data.pools as Array<Record<string, unknown>>) ?? []);

      return textResult({
        chain: cfg.name,
        version: cfg.version,
        orderBy,
        poolCount: pools.length,
        pools,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 4: get_pool_details
// ---------------------------------------------------------------------------
server.registerTool(
  "get_pool_details",
  {
    description:
      "Get detailed information about a specific Uniswap pool by its address/ID. " +
      "Returns token pair, fee tier, TVL, volume, fees, prices, tick, and liquidity data. " +
      "Use search_pools_by_token first if you don't know the pool address. " +
      "Example: 'Get details for pool 0x8ad5... on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address/ID (lowercase hex)"),
    },
  },
  async ({ chain, poolId }) => {
    try {
      const cfg = getChainConfig(chain);
      const hooksField = cfg.version === "v4" ? "hooks\n      tickSpacing" : "";
      const query = `{
        pool(id: "${poolId.toLowerCase()}") {
          id
          createdAtTimestamp
          createdAtBlockNumber
          token0 { id symbol name decimals derivedETH totalValueLockedUSD volumeUSD }
          token1 { id symbol name decimals derivedETH totalValueLockedUSD volumeUSD }
          feeTier
          liquidity
          sqrtPrice
          token0Price
          token1Price
          tick
          observationIndex
          volumeToken0
          volumeToken1
          volumeUSD
          feesUSD
          txCount
          totalValueLockedToken0
          totalValueLockedToken1
          totalValueLockedUSD
          totalValueLockedETH
          collectedFeesToken0
          collectedFeesToken1
          collectedFeesUSD
          liquidityProviderCount
          ${hooksField}
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const pool = data.pool as Record<string, unknown> | null;

      if (!pool) {
        return textResult({ error: `Pool ${poolId} not found on ${cfg.name}` });
      }

      const t0 = pool.token0 as Record<string, unknown>;
      const t1 = pool.token1 as Record<string, unknown>;

      pool._humanReadable = {
        pair: `${t0?.symbol}/${t1?.symbol}`,
        feeTier: formatFeeTier(pool.feeTier as string),
        tvl: formatUSD(pool.totalValueLockedUSD as string),
        totalVolume: formatUSD(pool.volumeUSD as string),
        totalFees: formatUSD(pool.feesUSD as string),
        collectedFees: formatUSD(pool.collectedFeesUSD as string),
        token0Price: `1 ${t1?.symbol} = ${formatNumber(pool.token0Price as string)} ${t0?.symbol}`,
        token1Price: `1 ${t0?.symbol} = ${formatNumber(pool.token1Price as string)} ${t1?.symbol}`,
        lpCount: pool.liquidityProviderCount,
        createdAt: formatTimestamp(pool.createdAtTimestamp as string),
      };

      return textResult({ chain: cfg.name, pool });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 5: get_recent_swaps
// ---------------------------------------------------------------------------
server.registerTool(
  "get_recent_swaps",
  {
    description:
      "Get recent swap events on Uniswap. Optionally filter by pool address. " +
      "Returns sender, amounts, USD value, price impact, and timestamps. " +
      "Use this to monitor trading activity or analyze swap patterns. " +
      "Example: 'Show me the last 20 swaps on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().optional().describe("Optional pool address to filter swaps"),
      limit: z.number().min(1).max(100).default(20).describe("Number of swaps (1-100)"),
      minAmountUSD: z.number().optional().describe("Minimum swap value in USD (e.g., 10000 for large trades)"),
    },
  },
  async ({ chain, poolId, limit, minAmountUSD }) => {
    try {
      const cfg = getChainConfig(chain);
      const where: string[] = [];
      if (poolId) where.push(`pool: "${poolId.toLowerCase()}"`);
      if (minAmountUSD) where.push(`amountUSD_gte: "${minAmountUSD}"`);
      const whereClause = where.length > 0 ? `where: { ${where.join(", ")} }` : "";

      const recipientField = cfg.version === "v3" ? "recipient" : "";

      const query = `{
        swaps(
          first: ${limit}
          orderBy: timestamp
          orderDirection: desc
          ${whereClause}
        ) {
          id
          timestamp
          pool { id token0 { symbol } token1 { symbol } feeTier }
          sender
          ${recipientField}
          origin
          amount0
          amount1
          amountUSD
          sqrtPriceX96
          tick
          logIndex
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const swaps = ((data.swaps as Array<Record<string, unknown>>) ?? []).map((swap) => {
        const pool = swap.pool as Record<string, unknown>;
        const t0 = pool?.token0 as Record<string, unknown>;
        const t1 = pool?.token1 as Record<string, unknown>;
        swap._humanReadable = {
          pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
          feeTier: formatFeeTier((pool?.feeTier ?? "0") as string),
          value: formatUSD(swap.amountUSD as string),
          amount0: formatNumber(swap.amount0 as string) + " " + (t0?.symbol ?? ""),
          amount1: formatNumber(swap.amount1 as string) + " " + (t1?.symbol ?? ""),
          time: formatTimestamp(swap.timestamp as string),
        };
        return swap;
      });

      return textResult({
        chain: cfg.name,
        version: cfg.version,
        swapCount: swaps.length,
        swaps,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 6: get_large_swaps (whale tracking)
// ---------------------------------------------------------------------------
server.registerTool(
  "get_large_swaps",
  {
    description:
      "Track whale swaps above a USD threshold. Useful for monitoring large trades, " +
      "detecting unusual activity, and tracking smart money movements. " +
      "Defaults to swaps over $100,000. " +
      "Example: 'Show me whale trades over $500K on Arbitrum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      minAmountUSD: z.number().default(100000).describe("Minimum swap value in USD (default: 100,000)"),
      limit: z.number().min(1).max(100).default(20).describe("Number of swaps (1-100)"),
    },
  },
  async ({ chain, minAmountUSD, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const recipientField = cfg.version === "v3" ? "recipient" : "";

      // Filter to last 24 hours so results are recent, not all-time
      const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
      const query = `{
        swaps(
          first: ${limit}
          orderBy: amountUSD
          orderDirection: desc
          where: { amountUSD_gte: "${minAmountUSD}", timestamp_gte: "${oneDayAgo}" }
        ) {
          id
          timestamp
          pool { id token0 { symbol } token1 { symbol } feeTier }
          sender
          ${recipientField}
          origin
          amount0
          amount1
          amountUSD
          tick
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const swaps = ((data.swaps as Array<Record<string, unknown>>) ?? []).map((swap) => {
        const pool = swap.pool as Record<string, unknown>;
        const t0 = pool?.token0 as Record<string, unknown>;
        const t1 = pool?.token1 as Record<string, unknown>;
        swap._humanReadable = {
          pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
          value: formatUSD(swap.amountUSD as string),
          time: formatTimestamp(swap.timestamp as string),
        };
        return swap;
      });

      return textResult({
        chain: cfg.name,
        threshold: formatUSD(minAmountUSD),
        swapCount: swaps.length,
        swaps,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 7: get_recent_liquidity_events
// ---------------------------------------------------------------------------
server.registerTool(
  "get_recent_liquidity_events",
  {
    description:
      "Get recent liquidity add/remove events. V3 returns mints and burns, " +
      "V4 returns modifyLiquidity events. Optionally filter by pool. " +
      "Use this to track LP behavior or detect liquidity pulls. " +
      "Example: 'Show recent liquidity events on Base V4'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().optional().describe("Optional pool address to filter"),
      limit: z.number().min(1).max(100).default(20).describe("Number of events (1-100)"),
    },
  },
  async ({ chain, poolId, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const whereClause = poolId ? `where: { pool: "${poolId.toLowerCase()}" }` : "";

      let query: string;
      if (cfg.version === "v4") {
        query = `{
          modifyLiquidities(
            first: ${limit}
            orderBy: timestamp
            orderDirection: desc
            ${whereClause}
          ) {
            id
            timestamp
            pool { id token0 { symbol } token1 { symbol } feeTier }
            sender
            origin
            amount
            amount0
            amount1
            amountUSD
            tickLower
            tickUpper
            logIndex
          }
        }`;
      } else {
        const half = Math.ceil(limit / 2);
        query = `{
          mints(
            first: ${half}
            orderBy: timestamp
            orderDirection: desc
            ${whereClause}
          ) {
            id
            timestamp
            pool { id token0 { symbol } token1 { symbol } feeTier }
            owner
            sender
            origin
            amount
            amount0
            amount1
            amountUSD
            tickLower
            tickUpper
          }
          burns(
            first: ${half}
            orderBy: timestamp
            orderDirection: desc
            ${whereClause}
          ) {
            id
            timestamp
            pool { id token0 { symbol } token1 { symbol } feeTier }
            owner
            origin
            amount
            amount0
            amount1
            amountUSD
            tickLower
            tickUpper
          }
        }`;
      }

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;

      if (cfg.version === "v4") {
        const events = ((data.modifyLiquidities as Array<Record<string, unknown>>) ?? []).map((ev) => {
          const pool = ev.pool as Record<string, unknown>;
          const t0 = pool?.token0 as Record<string, unknown>;
          const t1 = pool?.token1 as Record<string, unknown>;
          const amt = Number(ev.amount as string);
          ev._humanReadable = {
            pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
            type: amt > 0 ? "ADD" : amt < 0 ? "REMOVE" : "MODIFY",
            value: formatUSD(ev.amountUSD as string),
            tickRange: `${ev.tickLower} to ${ev.tickUpper}`,
            time: formatTimestamp(ev.timestamp as string),
          };
          return ev;
        });
        return textResult({ chain: cfg.name, version: "v4", eventCount: events.length, events });
      } else {
        const mints = ((data.mints as Array<Record<string, unknown>>) ?? []).map((m) => {
          const pool = m.pool as Record<string, unknown>;
          const t0 = pool?.token0 as Record<string, unknown>;
          const t1 = pool?.token1 as Record<string, unknown>;
          m._humanReadable = {
            pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
            type: "ADD",
            value: formatUSD(m.amountUSD as string),
            tickRange: `${m.tickLower} to ${m.tickUpper}`,
            time: formatTimestamp(m.timestamp as string),
          };
          return m;
        });
        const burns = ((data.burns as Array<Record<string, unknown>>) ?? []).map((b) => {
          const pool = b.pool as Record<string, unknown>;
          const t0 = pool?.token0 as Record<string, unknown>;
          const t1 = pool?.token1 as Record<string, unknown>;
          b._humanReadable = {
            pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
            type: "REMOVE",
            value: formatUSD(b.amountUSD as string),
            tickRange: `${b.tickLower} to ${b.tickUpper}`,
            time: formatTimestamp(b.timestamp as string),
          };
          return b;
        });
        return textResult({
          chain: cfg.name,
          version: "v3",
          mintCount: mints.length,
          burnCount: burns.length,
          mints,
          burns,
        });
      }
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 8: search_pools_by_token
// ---------------------------------------------------------------------------
server.registerTool(
  "search_pools_by_token",
  {
    description:
      "Search for Uniswap pools containing a specific token by symbol or address. " +
      "Returns pools sorted by TVL. Use this to find the best pool for a token pair. " +
      "Example: 'Find all WETH pools on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      tokenSymbol: z.string().optional().describe("Token symbol (e.g., 'WETH', 'USDC')"),
      tokenAddress: z.string().optional().describe("Token contract address (lowercase hex)"),
      limit: z.number().min(1).max(50).default(10).describe("Number of pools (1-50)"),
    },
  },
  async ({ chain, tokenSymbol, tokenAddress, limit }) => {
    try {
      const cfg = getChainConfig(chain);

      if (!tokenSymbol && !tokenAddress) {
        return errorResult("Provide either tokenSymbol or tokenAddress");
      }

      let whereClause: string;
      if (tokenAddress) {
        const addr = tokenAddress.toLowerCase();
        whereClause = `where: { or: [{ token0: "${addr}" }, { token1: "${addr}" }] }`;
      } else {
        const tokenQuery = `{
          tokens(
            first: 5
            where: { symbol_contains_nocase: "${tokenSymbol}" }
            orderBy: totalValueLockedUSD
            orderDirection: desc
          ) { id symbol name }
        }`;
        const tokenData = (await querySubgraph(cfg.subgraphId, tokenQuery)) as Record<string, unknown>;
        const tokens = (tokenData.tokens as Array<Record<string, unknown>>) ?? [];
        if (tokens.length === 0) {
          return textResult({ error: `No tokens found matching "${tokenSymbol}" on ${cfg.name}` });
        }
        const tokenIds = tokens.map((t) => `"${(t.id as string).toLowerCase()}"`);
        whereClause = `where: { or: [{ token0_in: [${tokenIds.join(",")}] }, { token1_in: [${tokenIds.join(",")}] }] }`;
      }

      const hooksField = cfg.version === "v4" ? "hooks\n        tickSpacing" : "";
      const query = `{
        pools(
          first: ${limit}
          orderBy: totalValueLockedUSD
          orderDirection: desc
          ${whereClause}
        ) {
          id
          token0 { id symbol name decimals }
          token1 { id symbol name decimals }
          feeTier
          totalValueLockedUSD
          volumeUSD
          feesUSD
          txCount
          token0Price
          token1Price
          ${hooksField}
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const pools = annotatePools((data.pools as Array<Record<string, unknown>>) ?? []);

      return textResult({
        chain: cfg.name,
        searchedFor: tokenSymbol ?? tokenAddress,
        poolCount: pools.length,
        pools,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 9: get_token_info
// ---------------------------------------------------------------------------
server.registerTool(
  "get_token_info",
  {
    description:
      "Get detailed token information including price, volume, TVL, pool count. " +
      "Search by symbol or address. " +
      "Example: 'Get WETH token info on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      tokenSymbol: z.string().optional().describe("Token symbol (e.g., 'WETH')"),
      tokenAddress: z.string().optional().describe("Token contract address"),
    },
  },
  async ({ chain, tokenSymbol, tokenAddress }) => {
    try {
      const cfg = getChainConfig(chain);

      let whereClause: string;
      if (tokenAddress) {
        whereClause = `id: "${tokenAddress.toLowerCase()}"`;
      } else if (tokenSymbol) {
        whereClause = `symbol_contains_nocase: "${tokenSymbol}"`;
      } else {
        return errorResult("Provide either tokenSymbol or tokenAddress");
      }

      const bundleQuery = `{ bundle(id: "1") { ethPriceUSD } }`;
      const tokenQuery = `{
        tokens(
          first: 5
          where: { ${whereClause} }
          orderBy: totalValueLockedUSD
          orderDirection: desc
        ) {
          id
          symbol
          name
          decimals
          volume
          volumeUSD
          feesUSD
          txCount
          poolCount
          totalValueLocked
          totalValueLockedUSD
          derivedETH
        }
      }`;

      const [bundleData, tokenData] = await Promise.all([
        querySubgraph(cfg.subgraphId, bundleQuery),
        querySubgraph(cfg.subgraphId, tokenQuery),
      ]);

      const ethPrice = Number(
        ((bundleData as Record<string, unknown>).bundle as Record<string, unknown>)?.ethPriceUSD ?? 0
      );
      const tokens = ((tokenData as Record<string, unknown>).tokens as Array<Record<string, unknown>>) ?? [];

      const annotated = tokens.map((token) => {
        const derivedETH = Number(token.derivedETH ?? 0);
        const priceUSD = derivedETH * ethPrice;
        token._humanReadable = {
          priceUSD: formatUSD(priceUSD),
          totalVolume: formatUSD(token.volumeUSD as string),
          totalFees: formatUSD(token.feesUSD as string),
          tvl: formatUSD(token.totalValueLockedUSD as string),
          txCount: formatNumber(token.txCount as string),
        };
        return token;
      });

      return textResult({
        chain: cfg.name,
        ethPriceUSD: formatUSD(ethPrice),
        tokenCount: annotated.length,
        tokens: annotated,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 10: get_token_day_data
// ---------------------------------------------------------------------------
server.registerTool(
  "get_token_day_data",
  {
    description:
      "Get historical daily OHLC price data for a token. " +
      "Returns date, open, high, low, close prices, volume, and TVL for each day. " +
      "Example: 'Show me WETH daily price data for the last 30 days on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      tokenAddress: z.string().describe("Token contract address (lowercase hex)"),
      days: z.number().min(1).max(365).default(30).describe("Number of days of history (1-365)"),
    },
  },
  async ({ chain, tokenAddress, days }) => {
    try {
      const cfg = getChainConfig(chain);
      const query = `{
        tokenDayDatas(
          first: ${days}
          orderBy: date
          orderDirection: desc
          where: { token: "${tokenAddress.toLowerCase()}" }
        ) {
          date
          priceUSD
          open
          high
          low
          close
          volumeUSD
          totalValueLockedUSD
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const dayDatas = ((data.tokenDayDatas as Array<Record<string, unknown>>) ?? []).map((d) => {
        d._humanReadable = {
          date: new Date(Number(d.date) * 1000).toISOString().slice(0, 10),
          price: formatUSD(d.priceUSD as string),
          open: formatUSD(d.open as string),
          high: formatUSD(d.high as string),
          low: formatUSD(d.low as string),
          close: formatUSD(d.close as string),
          volume: formatUSD(d.volumeUSD as string),
          tvl: formatUSD(d.totalValueLockedUSD as string),
        };
        return d;
      });

      return textResult({ chain: cfg.name, tokenAddress, dayCount: dayDatas.length, dayDatas });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 11: get_pool_day_data
// ---------------------------------------------------------------------------
server.registerTool(
  "get_pool_day_data",
  {
    description:
      "Get historical daily data for a specific pool: OHLC, volume, fees, TVL, liquidity. " +
      "Useful for pool performance analysis and fee APR calculation. " +
      "Example: 'Show me daily data for the ETH/USDC pool on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address"),
      days: z.number().min(1).max(365).default(30).describe("Number of days (1-365)"),
    },
  },
  async ({ chain, poolId, days }) => {
    try {
      const cfg = getChainConfig(chain);
      const query = `{
        poolDayDatas(
          first: ${days}
          orderBy: date
          orderDirection: desc
          where: { pool: "${poolId.toLowerCase()}" }
        ) {
          date
          liquidity
          sqrtPrice
          token0Price
          token1Price
          tick
          tvlUSD
          volumeToken0
          volumeToken1
          volumeUSD
          feesUSD
          txCount
          open
          high
          low
          close
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const dayDatas = ((data.poolDayDatas as Array<Record<string, unknown>>) ?? []).map((d) => {
        d._humanReadable = {
          date: new Date(Number(d.date) * 1000).toISOString().slice(0, 10),
          tvl: formatUSD(d.tvlUSD as string),
          volume: formatUSD(d.volumeUSD as string),
          fees: formatUSD(d.feesUSD as string),
          txCount: d.txCount,
        };
        return d;
      });

      return textResult({ chain: cfg.name, poolId, dayCount: dayDatas.length, dayDatas });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 12: get_pool_ticks
// ---------------------------------------------------------------------------
server.registerTool(
  "get_pool_ticks",
  {
    description:
      "Get the active tick data (liquidity distribution) for a pool. " +
      "Shows liquidity at each price tick. " +
      "Example: 'Show me the tick distribution for the ETH/USDC pool'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address"),
      limit: z.number().min(1).max(500).default(100).describe("Number of ticks (1-500)"),
    },
  },
  async ({ chain, poolId, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const query = `{
        ticks(
          first: ${limit}
          orderBy: tickIdx
          orderDirection: asc
          where: { pool: "${poolId.toLowerCase()}" }
        ) {
          tickIdx
          liquidityGross
          liquidityNet
          price0
          price1
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const ticks = (data.ticks as Array<Record<string, unknown>>) ?? [];

      return textResult({ chain: cfg.name, poolId, tickCount: ticks.length, ticks });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 13: simulate_swap
// ---------------------------------------------------------------------------

/**
 * Uniswap V3 tick math constants.
 * sqrtPriceAtTick(i) = 1.0001^(i/2), so price(i) = 1.0001^i
 * We work in floating-point for simulation (not exact onchain math, but
 * close enough for price-impact estimation).
 */
const SQRT_1_0001 = Math.sqrt(1.0001); // ~1.000049998750

function tickToSqrtPrice(tick: number): number {
  return Math.pow(SQRT_1_0001, tick);
}

function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

interface TickData {
  tickIdx: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
}

/**
 * Simulate a swap through concentrated-liquidity ticks.
 *
 * This walks the tick range from the pool's current tick, consuming liquidity
 * at each initialized tick boundary. It returns the estimated output amount
 * and effective price.
 *
 * NOTE: This is an off-chain estimate. It does not account for:
 * - V4 hooks that modify swap behavior
 * - Exact Solidity Q64.96 fixed-point rounding
 * - Protocol fees beyond the pool fee tier
 * - Changes in pool state between query and execution
 */
function simulateSwapMath(
  currentTick: number,
  currentSqrtPrice: number,
  currentLiquidity: bigint,
  ticks: TickData[],
  amountIn: number,
  zeroForOne: boolean, // true = selling token0 for token1
  feeBps: number, // fee in basis points (e.g. 3000 = 0.30%)
): {
  amountOut: number;
  effectivePrice: number;
  priceImpactPercent: number;
  ticksCrossed: number;
  insufficientLiquidity: boolean;
} {
  const feeRate = feeBps / 1_000_000; // feeTier is in hundredths of a bip
  let remainingIn = amountIn;
  let totalOut = 0;
  let liquidity = Number(currentLiquidity);
  let sqrtP = currentSqrtPrice;
  let ticksCrossed = 0;

  // Sort ticks appropriately
  const sortedTicks = [...ticks].sort((a, b) =>
    zeroForOne ? b.tickIdx - a.tickIdx : a.tickIdx - b.tickIdx
  );

  // Filter to relevant ticks (below current for zeroForOne, above for oneForZero)
  const relevantTicks = sortedTicks.filter((t) =>
    zeroForOne ? t.tickIdx <= currentTick : t.tickIdx > currentTick
  );

  // Spot price before the swap (price of token0 in terms of token1)
  const spotPriceBefore = sqrtP * sqrtP;

  for (const tick of relevantTicks) {
    if (remainingIn <= 0) break;

    const targetSqrtP = tickToSqrtPrice(tick.tickIdx);

    if (liquidity <= 0) {
      // No liquidity in this range, skip to next tick
      sqrtP = targetSqrtP;
      liquidity += Number(tick.liquidityNet) * (zeroForOne ? -1 : 1);
      ticksCrossed++;
      continue;
    }

    // Calculate max amount that can be swapped in this tick range
    let maxAmountIn: number;
    let amountOutInRange: number;

    if (zeroForOne) {
      // Selling token0: dx = L * (1/sqrtP_target - 1/sqrtP_current)
      const invSqrtTarget = 1 / targetSqrtP;
      const invSqrtCurrent = 1 / sqrtP;
      maxAmountIn = liquidity * Math.abs(invSqrtTarget - invSqrtCurrent);
      const afterFee = Math.min(remainingIn * (1 - feeRate), maxAmountIn);
      // dy = L * (sqrtP_current - sqrtP_next)
      if (afterFee >= maxAmountIn) {
        // We consume the entire range
        amountOutInRange = liquidity * Math.abs(sqrtP - targetSqrtP);
        remainingIn -= maxAmountIn / (1 - feeRate);
        sqrtP = targetSqrtP;
      } else {
        // Partial fill within this range
        const newInvSqrtP = invSqrtCurrent + afterFee / liquidity;
        const newSqrtP = 1 / newInvSqrtP;
        amountOutInRange = liquidity * Math.abs(sqrtP - newSqrtP);
        remainingIn = 0;
        sqrtP = newSqrtP;
      }
    } else {
      // Selling token1: dy = L * (sqrtP_target - sqrtP_current)
      maxAmountIn = liquidity * Math.abs(targetSqrtP - sqrtP);
      const afterFee = Math.min(remainingIn * (1 - feeRate), maxAmountIn);
      // dx = L * (1/sqrtP_current - 1/sqrtP_next)
      if (afterFee >= maxAmountIn) {
        amountOutInRange = liquidity * Math.abs(1 / sqrtP - 1 / targetSqrtP);
        remainingIn -= maxAmountIn / (1 - feeRate);
        sqrtP = targetSqrtP;
      } else {
        const newSqrtP = sqrtP + afterFee / liquidity;
        amountOutInRange = liquidity * Math.abs(1 / sqrtP - 1 / newSqrtP);
        remainingIn = 0;
        sqrtP = newSqrtP;
      }
    }

    totalOut += amountOutInRange;

    // Cross the tick and update liquidity
    if (remainingIn > 0) {
      liquidity += Number(tick.liquidityNet) * (zeroForOne ? -1 : 1);
      ticksCrossed++;
    }
  }

  const effectivePrice = amountIn > 0 && totalOut > 0 ? totalOut / amountIn : 0;
  const spotPrice = zeroForOne ? spotPriceBefore : 1 / spotPriceBefore;
  const priceImpactPercent =
    spotPrice > 0 ? ((spotPrice - effectivePrice) / spotPrice) * 100 : 0;

  return {
    amountOut: totalOut,
    effectivePrice,
    priceImpactPercent: Math.abs(priceImpactPercent),
    ticksCrossed,
    insufficientLiquidity: remainingIn > amountIn * 0.01, // >1% unfilled
  };
}

server.registerTool(
  "simulate_swap",
  {
    description:
      "Simulate a swap through a Uniswap pool to estimate output amount, effective price, " +
      "and price impact. Uses the pool's current tick liquidity distribution to walk the tick " +
      "range. This is an off-chain estimate, not an exact on-chain quote. " +
      "Example: 'Simulate swapping 10 WETH for USDC in pool 0x8ad5... on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address"),
      amountIn: z.number().positive().describe(
        "Amount of input token to swap (in human-readable units, e.g. 10.5 for 10.5 WETH)"
      ),
      zeroForOne: z.boolean().describe(
        "Direction: true = sell token0 for token1, false = sell token1 for token0"
      ),
    },
  },
  async ({ chain, poolId, amountIn, zeroForOne }) => {
    try {
      const cfg = getChainConfig(chain);
      const poolIdLower = poolId.toLowerCase();

      // Fetch pool state first, then ticks on the correct side of current tick
      const hooksField = cfg.version === "v4" ? "hooks" : "";
      const poolQuery = `{
        pool(id: "${poolIdLower}") {
          tick
          sqrtPrice
          liquidity
          feeTier
          token0 { symbol name decimals }
          token1 { symbol name decimals }
          token0Price
          token1Price
          totalValueLockedUSD
          ${hooksField}
        }
      }`;

      const poolData = await querySubgraph(cfg.subgraphId, poolQuery);
      const pool = (poolData as Record<string, unknown>).pool as Record<string, unknown> | null;
      if (!pool) {
        return textResult({ error: `Pool ${poolId} not found on ${cfg.name}` });
      }

      // Fetch ticks on the correct side of current tick for the swap direction
      const currentTick = Number(pool.tick);
      const tickFilter = zeroForOne
        ? `tickIdx_lte: ${currentTick}`
        : `tickIdx_gte: ${currentTick}`;
      const tickOrder = zeroForOne ? "desc" : "asc";
      const tickQuery = `{
        ticks(
          first: 500
          orderBy: tickIdx
          orderDirection: ${tickOrder}
          where: { pool: "${poolIdLower}", liquidityGross_gt: "0", ${tickFilter} }
        ) {
          tickIdx
          liquidityNet
          liquidityGross
        }
      }`;
      const tickData = await querySubgraph(cfg.subgraphId, tickQuery);

      const rawTicks = ((tickData as Record<string, unknown>).ticks as Array<Record<string, unknown>>) ?? [];
      if (rawTicks.length === 0) {
        return textResult({ error: "No initialized ticks found. Pool may have zero liquidity." });
      }

      const ticks: TickData[] = rawTicks.map((t) => ({
        tickIdx: Number(t.tickIdx),
        liquidityNet: BigInt(t.liquidityNet as string),
        liquidityGross: BigInt(t.liquidityGross as string),
      }));
      const feeTier = Number(pool.feeTier);
      const currentLiquidity = BigInt(pool.liquidity as string);

      // sqrtPrice from the subgraph is in Q96 format (sqrtPriceX96)
      // Convert: sqrtPrice = sqrtPriceX96 / 2^96
      const sqrtPriceX96 = BigInt(pool.sqrtPrice as string);
      const Q96 = BigInt(2) ** BigInt(96);
      const currentSqrtPrice = Number(sqrtPriceX96) / Number(Q96);

      const t0 = pool.token0 as Record<string, unknown>;
      const t1 = pool.token1 as Record<string, unknown>;
      const inputToken = zeroForOne ? t0 : t1;
      const outputToken = zeroForOne ? t1 : t0;

      // Convert human-readable amountIn to raw units for the simulation
      const inputDecimals = Number(inputToken.decimals ?? 18);
      const outputDecimals = Number(outputToken.decimals ?? 18);
      const rawAmountIn = amountIn * Math.pow(10, inputDecimals);

      const result = simulateSwapMath(
        currentTick,
        currentSqrtPrice,
        currentLiquidity,
        ticks,
        rawAmountIn,
        zeroForOne,
        feeTier,
      );

      // Convert raw output back to human-readable units
      const adjustedAmountOut = result.amountOut / Math.pow(10, outputDecimals);
      const adjustedEffectivePrice = amountIn > 0 ? adjustedAmountOut / amountIn : 0;

      // Spot price from the pool (tokenXPrice = amount of tokenX per 1 unit of the other token)
      // zeroForOne: selling token0 for token1, so spot = token1 per token0 = token1Price
      // oneForZero: selling token1 for token0, so spot = token0 per token1 = token0Price
      const spotPrice = zeroForOne
        ? Number(pool.token1Price as string)
        : Number(pool.token0Price as string);
      const priceImpact = spotPrice > 0
        ? Math.abs((spotPrice - adjustedEffectivePrice) / spotPrice) * 100
        : result.priceImpactPercent;

      return textResult({
        chain: cfg.name,
        pool: {
          id: poolIdLower,
          pair: `${t0.symbol}/${t1.symbol}`,
          feeTier: formatFeeTier(feeTier),
          currentTick,
          tvl: formatUSD(pool.totalValueLockedUSD as string),
          hooks: pool.hooks,
        },
        swap: {
          direction: `${inputToken.symbol} -> ${outputToken.symbol}`,
          amountIn: `${amountIn} ${inputToken.symbol}`,
          estimatedOut: `${formatNumber(adjustedAmountOut)} ${outputToken.symbol}`,
          spotPrice: `1 ${inputToken.symbol} = ${formatNumber(spotPrice)} ${outputToken.symbol}`,
          effectivePrice: `1 ${inputToken.symbol} = ${formatNumber(adjustedEffectivePrice)} ${outputToken.symbol}`,
          priceImpactPercent: `${priceImpact.toFixed(4)}%`,
          ticksCrossed: result.ticksCrossed,
          insufficientLiquidity: result.insufficientLiquidity,
        },
        _disclaimer: "Off-chain estimate. Actual execution may differ due to pool state changes, MEV, rounding, and V4 hook effects.",
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 14: get_price_impact
// ---------------------------------------------------------------------------

server.registerTool(
  "get_price_impact",
  {
    description:
      "Calculate price impact for multiple trade sizes on a Uniswap pool. " +
      "Returns a table of trade sizes with their estimated output and price impact percentage. " +
      "Useful for finding optimal trade sizes or assessing pool depth. " +
      "Example: 'What is the price impact of trading 1, 10, 100, and 1000 ETH on the ETH/USDC pool?'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address"),
      tradeSizes: z.array(z.number().positive()).describe(
        "Array of trade sizes in human-readable units (e.g. [1, 10, 100, 1000])"
      ),
      zeroForOne: z.boolean().describe(
        "Direction: true = sell token0 for token1, false = sell token1 for token0"
      ),
    },
  },
  async ({ chain, poolId, tradeSizes, zeroForOne }) => {
    try {
      const cfg = getChainConfig(chain);
      const poolIdLower = poolId.toLowerCase();

      const hooksField = cfg.version === "v4" ? "hooks" : "";
      const poolQuery = `{
        pool(id: "${poolIdLower}") {
          tick
          sqrtPrice
          liquidity
          feeTier
          token0 { symbol name decimals }
          token1 { symbol name decimals }
          token0Price
          token1Price
          totalValueLockedUSD
          ${hooksField}
        }
      }`;

      const poolData = await querySubgraph(cfg.subgraphId, poolQuery);
      const pool = (poolData as Record<string, unknown>).pool as Record<string, unknown> | null;
      if (!pool) {
        return textResult({ error: `Pool ${poolId} not found on ${cfg.name}` });
      }

      // Fetch ticks on the correct side of current tick for the swap direction
      const currentTick = Number(pool.tick);
      const tickFilter = zeroForOne
        ? `tickIdx_lte: ${currentTick}`
        : `tickIdx_gte: ${currentTick}`;
      const tickOrder = zeroForOne ? "desc" : "asc";
      const tickQuery = `{
        ticks(
          first: 500
          orderBy: tickIdx
          orderDirection: ${tickOrder}
          where: { pool: "${poolIdLower}", liquidityGross_gt: "0", ${tickFilter} }
        ) {
          tickIdx
          liquidityNet
          liquidityGross
        }
      }`;
      const tickData = await querySubgraph(cfg.subgraphId, tickQuery);

      const rawTicks = ((tickData as Record<string, unknown>).ticks as Array<Record<string, unknown>>) ?? [];
      if (rawTicks.length === 0) {
        return textResult({ error: "No initialized ticks found. Pool may have zero liquidity." });
      }

      const ticks: TickData[] = rawTicks.map((t) => ({
        tickIdx: Number(t.tickIdx),
        liquidityNet: BigInt(t.liquidityNet as string),
        liquidityGross: BigInt(t.liquidityGross as string),
      }));

      const feeTier = Number(pool.feeTier);
      const currentLiquidity = BigInt(pool.liquidity as string);
      const sqrtPriceX96 = BigInt(pool.sqrtPrice as string);
      const Q96 = BigInt(2) ** BigInt(96);
      const currentSqrtPrice = Number(sqrtPriceX96) / Number(Q96);

      const t0 = pool.token0 as Record<string, unknown>;
      const t1 = pool.token1 as Record<string, unknown>;
      const inputToken = zeroForOne ? t0 : t1;
      const outputToken = zeroForOne ? t1 : t0;
      const inputDecimals = Number(inputToken.decimals ?? 18);
      const outputDecimals = Number(outputToken.decimals ?? 18);

      // Spot price: tokenXPrice = amount of tokenX per 1 unit of the other token
      const spotPrice = zeroForOne
        ? Number(pool.token1Price as string)
        : Number(pool.token0Price as string);

      const impacts = tradeSizes.map((size) => {
        const rawAmountIn = size * Math.pow(10, inputDecimals);
        const result = simulateSwapMath(
          currentTick,
          currentSqrtPrice,
          currentLiquidity,
          ticks,
          rawAmountIn,
          zeroForOne,
          feeTier,
        );

        const adjustedOut = result.amountOut / Math.pow(10, outputDecimals);
        const effectivePrice = adjustedOut / size;
        const impact = spotPrice > 0
          ? Math.abs((spotPrice - effectivePrice) / spotPrice) * 100
          : result.priceImpactPercent;

        return {
          tradeSize: `${size} ${inputToken.symbol}`,
          estimatedOut: `${formatNumber(adjustedOut)} ${outputToken.symbol}`,
          effectivePrice: `${formatNumber(effectivePrice)} ${outputToken.symbol}/${inputToken.symbol}`,
          priceImpact: `${impact.toFixed(4)}%`,
          ticksCrossed: result.ticksCrossed,
          insufficientLiquidity: result.insufficientLiquidity,
        };
      });

      return textResult({
        chain: cfg.name,
        pool: {
          id: poolIdLower,
          pair: `${t0.symbol}/${t1.symbol}`,
          feeTier: formatFeeTier(feeTier),
          tvl: formatUSD(pool.totalValueLockedUSD as string),
          spotPrice: `1 ${inputToken.symbol} = ${formatNumber(spotPrice)} ${outputToken.symbol}`,
        },
        direction: `${inputToken.symbol} -> ${outputToken.symbol}`,
        impacts,
        _disclaimer: "Off-chain estimates. Actual execution may differ.",
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 15: get_eth_price (was 13)
// ---------------------------------------------------------------------------
server.registerTool(
  "get_eth_price",
  {
    description:
      "Get the current ETH price in USD from Uniswap's price oracle on a specific chain. " +
      "On non-Ethereum chains (Polygon, etc.), this returns the native token price (e.g. POL), not ETH. " +
      "Example: 'What is the ETH price on Ethereum according to Uniswap?'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
    },
  },
  async ({ chain }) => {
    try {
      const cfg = getChainConfig(chain);
      const query = `{ bundle(id: "1") { ethPriceUSD } }`;
      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const bundle = data.bundle as Record<string, unknown>;

      return textResult({
        chain: cfg.name,
        ethPriceUSD: bundle?.ethPriceUSD,
        formatted: formatUSD(bundle?.ethPriceUSD as string),
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 14: get_protocol_day_data
// ---------------------------------------------------------------------------
server.registerTool(
  "get_protocol_day_data",
  {
    description:
      "Get daily protocol-level statistics: total volume, fees, TVL, tx count per day. " +
      "Useful for tracking protocol growth and spotting trends. " +
      "Example: 'Show me Uniswap V3 Ethereum daily stats for the last 7 days'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      days: z.number().min(1).max(365).default(7).describe("Number of days (1-365)"),
    },
  },
  async ({ chain, days }) => {
    try {
      const cfg = getChainConfig(chain);
      // PancakeSwap uses pancakeDayDatas, Uniswap uses uniswapDayDatas
      const entityName = chain === "bsc-v3" ? "pancakeDayDatas" : "uniswapDayDatas";
      const query = `{
        ${entityName}(
          first: ${days}
          orderBy: date
          orderDirection: desc
        ) {
          date
          volumeETH
          volumeUSD
          feesUSD
          txCount
          tvlUSD
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const dayDatas = ((data[entityName] as Array<Record<string, unknown>>) ?? []).map((d) => {
        d._humanReadable = {
          date: new Date(Number(d.date) * 1000).toISOString().slice(0, 10),
          volume: formatUSD(d.volumeUSD as string),
          fees: formatUSD(d.feesUSD as string),
          tvl: formatUSD(d.tvlUSD as string),
          txCount: formatNumber(d.txCount as string),
        };
        return d;
      });

      return textResult({ chain: cfg.name, dayCount: dayDatas.length, dayDatas });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 17: get_new_pools
// ---------------------------------------------------------------------------
server.registerTool(
  "get_new_pools",
  {
    description:
      "Get recently created Uniswap pools. Filter by time window (hours ago). " +
      "Returns pool pair, fee tier, TVL, volume, creation time. " +
      "Useful for discovering new token listings and fresh liquidity. " +
      "Example: 'Show me pools created in the last 24 hours on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      hoursAgo: z.number().min(1).max(720).default(24).describe(
        "How far back to look, in hours (default: 24, max: 720 = 30 days)"
      ),
      limit: z.number().min(1).max(100).default(20).describe("Number of pools (1-100)"),
      minTVL: z.number().default(0).describe(
        "Minimum TVL in USD to filter out empty/spam pools (default: 0)"
      ),
    },
  },
  async ({ chain, hoursAgo, limit, minTVL }) => {
    try {
      const cfg = getChainConfig(chain);
      const cutoff = Math.floor(Date.now() / 1000) - hoursAgo * 3600;
      const hooksField = cfg.version === "v4" ? "hooks\n        tickSpacing" : "";
      const tvlFilter = minTVL > 0 ? `, totalValueLockedUSD_gt: "${minTVL}"` : "";

      const query = `{
        pools(
          first: ${limit}
          orderBy: createdAtTimestamp
          orderDirection: desc
          where: { createdAtTimestamp_gt: "${cutoff}"${tvlFilter} }
        ) {
          id
          createdAtTimestamp
          createdAtBlockNumber
          token0 { id symbol name decimals }
          token1 { id symbol name decimals }
          feeTier
          totalValueLockedUSD
          volumeUSD
          feesUSD
          txCount
          token0Price
          token1Price
          ${hooksField}
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const pools = ((data.pools as Array<Record<string, unknown>>) ?? []).map((pool) => {
        const t0 = pool.token0 as Record<string, unknown>;
        const t1 = pool.token1 as Record<string, unknown>;
        pool._humanReadable = {
          pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
          feeTier: pool.feeTier ? formatFeeTier(pool.feeTier as string) : "N/A",
          tvl: formatUSD(pool.totalValueLockedUSD as string),
          volume: formatUSD(pool.volumeUSD as string),
          createdAt: formatTimestamp(pool.createdAtTimestamp as string),
        };
        return pool;
      });

      return textResult({
        chain: cfg.name,
        version: cfg.version,
        timeWindow: `Last ${hoursAgo} hours`,
        minTVL: minTVL > 0 ? formatUSD(minTVL) : "none",
        poolCount: pools.length,
        pools,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 18: get_top_tokens
// ---------------------------------------------------------------------------
server.registerTool(
  "get_top_tokens",
  {
    description:
      "Get the top tokens on Uniswap ranked by volume, TVL, transaction count, or pool count. " +
      "Useful for discovering trending tokens, most traded assets, and tokens with the deepest liquidity. " +
      "Example: 'What are the top 10 tokens by volume on Ethereum V3?'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      orderBy: z.enum(["volumeUSD", "totalValueLockedUSD", "txCount"])
        .default("volumeUSD")
        .describe("Sort metric: volumeUSD (most traded), totalValueLockedUSD (most liquid), txCount (most active)"),
      limit: z.number().min(1).max(100).default(20).describe("Number of tokens (1-100)"),
    },
  },
  async ({ chain, orderBy, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const bundleQuery = `{ bundle(id: "1") { ethPriceUSD } }`;
      const tokenQuery = `{
        tokens(
          first: ${limit}
          orderBy: ${orderBy}
          orderDirection: desc
          where: { totalValueLockedUSD_gt: "100", txCount_gt: "100" }
        ) {
          id
          symbol
          name
          decimals
          volume
          volumeUSD
          feesUSD
          txCount
          poolCount
          totalValueLocked
          totalValueLockedUSD
          derivedETH
        }
      }`;

      const [bundleData, tokenData] = await Promise.all([
        querySubgraph(cfg.subgraphId, bundleQuery),
        querySubgraph(cfg.subgraphId, tokenQuery),
      ]);

      const ethPrice = Number(
        ((bundleData as Record<string, unknown>).bundle as Record<string, unknown>)?.ethPriceUSD ?? 0
      );
      const tokens = ((tokenData as Record<string, unknown>).tokens as Array<Record<string, unknown>>) ?? [];

      const annotated = tokens.map((token, i) => {
        const derivedETH = Number(token.derivedETH ?? 0);
        const priceUSD = derivedETH * ethPrice;
        token._humanReadable = {
          rank: i + 1,
          priceUSD: formatUSD(priceUSD),
          totalVolume: formatUSD(token.volumeUSD as string),
          totalFees: formatUSD(token.feesUSD as string),
          tvl: formatUSD(token.totalValueLockedUSD as string),
          txCount: formatNumber(token.txCount as string),
        };
        return token;
      });

      return textResult({
        chain: cfg.name,
        version: cfg.version,
        orderBy,
        ethPriceUSD: formatUSD(ethPrice),
        tokenCount: annotated.length,
        tokens: annotated,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 19: get_pool_hour_data
// ---------------------------------------------------------------------------
server.registerTool(
  "get_pool_hour_data",
  {
    description:
      "Get hourly data for a specific pool: price, volume, fees, TVL, liquidity. " +
      "Useful for intraday analysis, short-term trends, and detecting sudden changes. " +
      "Example: 'Show me hourly data for the ETH/USDC pool over the last 24 hours'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address"),
      hours: z.number().min(1).max(168).default(24).describe("Number of hours of history (1-168, default 24)"),
    },
  },
  async ({ chain, poolId, hours }) => {
    try {
      const cfg = getChainConfig(chain);
      const query = `{
        poolHourDatas(
          first: ${hours}
          orderBy: periodStartUnix
          orderDirection: desc
          where: { pool: "${poolId.toLowerCase()}" }
        ) {
          periodStartUnix
          liquidity
          sqrtPrice
          token0Price
          token1Price
          tick
          tvlUSD
          volumeToken0
          volumeToken1
          volumeUSD
          feesUSD
          txCount
          open
          high
          low
          close
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const hourDatas = ((data.poolHourDatas as Array<Record<string, unknown>>) ?? []).map((d) => {
        d._humanReadable = {
          time: formatTimestamp(d.periodStartUnix as string),
          tvl: formatUSD(d.tvlUSD as string),
          volume: formatUSD(d.volumeUSD as string),
          fees: formatUSD(d.feesUSD as string),
          txCount: d.txCount,
        };
        return d;
      });

      return textResult({ chain: cfg.name, poolId, hourCount: hourDatas.length, hourDatas });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 20: get_token_hour_data
// ---------------------------------------------------------------------------
server.registerTool(
  "get_token_hour_data",
  {
    description:
      "Get hourly price and volume data for a token. " +
      "Useful for intraday price movements, volume spikes, and short-term analysis. " +
      "Example: 'Show me WETH hourly data for the last 12 hours on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      tokenAddress: z.string().describe("Token contract address (lowercase hex)"),
      hours: z.number().min(1).max(168).default(24).describe("Number of hours (1-168, default 24)"),
    },
  },
  async ({ chain, tokenAddress, hours }) => {
    try {
      const cfg = getChainConfig(chain);
      const query = `{
        tokenHourDatas(
          first: ${hours}
          orderBy: periodStartUnix
          orderDirection: desc
          where: { token: "${tokenAddress.toLowerCase()}" }
        ) {
          periodStartUnix
          priceUSD
          open
          high
          low
          close
          volumeUSD
          totalValueLockedUSD
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const hourDatas = ((data.tokenHourDatas as Array<Record<string, unknown>>) ?? []).map((d) => {
        d._humanReadable = {
          time: formatTimestamp(d.periodStartUnix as string),
          price: formatUSD(d.priceUSD as string),
          open: formatUSD(d.open as string),
          high: formatUSD(d.high as string),
          low: formatUSD(d.low as string),
          close: formatUSD(d.close as string),
          volume: formatUSD(d.volumeUSD as string),
          tvl: formatUSD(d.totalValueLockedUSD as string),
        };
        return d;
      });

      return textResult({ chain: cfg.name, tokenAddress, hourCount: hourDatas.length, hourDatas });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 21: get_pool_fee_apr
// ---------------------------------------------------------------------------
server.registerTool(
  "get_pool_fee_apr",
  {
    description:
      "Calculate the annualized fee APR for a Uniswap pool based on recent daily fee revenue and TVL. " +
      "Returns daily breakdown and annualized rate. This is what LPs earn from trading fees. " +
      "Example: 'What is the fee APR on the ETH/USDC 0.05% pool?'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address"),
      days: z.number().min(1).max(90).default(7).describe("Number of days to average over (default: 7)"),
    },
  },
  async ({ chain, poolId, days }) => {
    try {
      const cfg = getChainConfig(chain);
      const poolQuery = `{
        pool(id: "${poolId.toLowerCase()}") {
          token0 { symbol }
          token1 { symbol }
          feeTier
          totalValueLockedUSD
          feesUSD
          volumeUSD
        }
      }`;
      const dayQuery = `{
        poolDayDatas(
          first: ${days}
          orderBy: date
          orderDirection: desc
          where: { pool: "${poolId.toLowerCase()}" }
        ) {
          date
          feesUSD
          tvlUSD
          volumeUSD
        }
      }`;

      const [poolData, dayData] = await Promise.all([
        querySubgraph(cfg.subgraphId, poolQuery),
        querySubgraph(cfg.subgraphId, dayQuery),
      ]);

      const pool = (poolData as Record<string, unknown>).pool as Record<string, unknown> | null;
      if (!pool) return textResult({ error: `Pool ${poolId} not found on ${cfg.name}` });

      const dayDatas = ((dayData as Record<string, unknown>).poolDayDatas as Array<Record<string, unknown>>) ?? [];
      if (dayDatas.length === 0) return textResult({ error: "No daily data available for this pool." });

      const t0 = pool.token0 as Record<string, unknown>;
      const t1 = pool.token1 as Record<string, unknown>;

      const dailyBreakdown = dayDatas.map((d) => {
        const fees = Number(d.feesUSD ?? 0);
        const tvl = Number(d.tvlUSD ?? 0);
        const dailyRate = tvl > 0 ? fees / tvl : 0;
        const annualized = dailyRate * 365 * 100;
        return {
          date: new Date(Number(d.date) * 1000).toISOString().slice(0, 10),
          fees: formatUSD(fees),
          tvl: formatUSD(tvl),
          volume: formatUSD(d.volumeUSD as string),
          dailyRate: (dailyRate * 100).toFixed(4) + "%",
          annualizedAPR: annualized.toFixed(2) + "%",
        };
      });

      const totalFees = dayDatas.reduce((sum, d) => sum + Number(d.feesUSD ?? 0), 0);
      const avgTVL = dayDatas.reduce((sum, d) => sum + Number(d.tvlUSD ?? 0), 0) / dayDatas.length;
      const avgDailyRate = avgTVL > 0 ? totalFees / dayDatas.length / avgTVL : 0;
      const avgAnnualizedAPR = avgDailyRate * 365 * 100;

      return textResult({
        chain: cfg.name,
        pool: {
          pair: `${t0?.symbol}/${t1?.symbol}`,
          feeTier: formatFeeTier(pool.feeTier as string),
          currentTVL: formatUSD(pool.totalValueLockedUSD as string),
        },
        summary: {
          period: `${dayDatas.length} days`,
          totalFees: formatUSD(totalFees),
          avgDailyFees: formatUSD(totalFees / dayDatas.length),
          avgTVL: formatUSD(avgTVL),
          avgDailyRate: (avgDailyRate * 100).toFixed(4) + "%",
          annualizedAPR: avgAnnualizedAPR.toFixed(2) + "%",
        },
        dailyBreakdown,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 22: get_v4_hooks_pools
// ---------------------------------------------------------------------------
server.registerTool(
  "get_v4_hooks_pools",
  {
    description:
      "Find Uniswap V4 pools that use hooks contracts. V4 hooks allow custom logic " +
      "(dynamic fees, TWAMM, limit orders, etc.) to be attached to pools. " +
      "Filter by specific hooks address or find all hooked pools. " +
      "Example: 'Show me all V4 pools using hooks on Base'",
    inputSchema: {
      chain: z.enum(V4_CHAIN_NAMES).describe("V4 chain key (e.g., 'ethereum-v4', 'base-v4')"),
      hooksAddress: z.string().optional().describe("Filter by specific hooks contract address (optional)"),
      limit: z.number().min(1).max(100).default(20).describe("Number of pools (1-100)"),
    },
  },
  async ({ chain, hooksAddress, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const nullHooks = "0x0000000000000000000000000000000000000000";
      let whereClause: string;
      if (hooksAddress) {
        whereClause = `where: { hooks: "${hooksAddress.toLowerCase()}" }`;
      } else {
        whereClause = `where: { hooks_not: "${nullHooks}", totalValueLockedUSD_gt: "0" }`;
      }

      const query = `{
        pools(
          first: ${limit}
          orderBy: totalValueLockedUSD
          orderDirection: desc
          ${whereClause}
        ) {
          id
          hooks
          tickSpacing
          token0 { id symbol name }
          token1 { id symbol name }
          feeTier
          totalValueLockedUSD
          volumeUSD
          feesUSD
          txCount
          createdAtTimestamp
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const pools = ((data.pools as Array<Record<string, unknown>>) ?? []).map((pool) => {
        const t0 = pool.token0 as Record<string, unknown>;
        const t1 = pool.token1 as Record<string, unknown>;
        pool._humanReadable = {
          pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
          hooks: pool.hooks,
          feeTier: pool.feeTier ? formatFeeTier(pool.feeTier as string) : "N/A",
          tvl: formatUSD(pool.totalValueLockedUSD as string),
          volume: formatUSD(pool.volumeUSD as string),
          createdAt: formatTimestamp(pool.createdAtTimestamp as string),
        };
        return pool;
      });

      // Group by hooks address for summary
      const hooksSummary: Record<string, number> = {};
      for (const pool of pools) {
        const addr = pool.hooks as string;
        hooksSummary[addr] = (hooksSummary[addr] ?? 0) + 1;
      }

      return textResult({
        chain: cfg.name,
        version: "v4",
        filter: hooksAddress ?? "all hooked pools",
        poolCount: pools.length,
        uniqueHooksContracts: Object.keys(hooksSummary).length,
        hooksSummary,
        pools,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 23: get_positions (V4 only)
// ---------------------------------------------------------------------------
server.registerTool(
  "get_positions",
  {
    description:
      "Get LP positions on Uniswap V4. Filter by owner address or pool. " +
      "Returns position details including token pair, tick range, and liquidity. " +
      "V4 only (V3 does not have a queryable positions entity in the subgraph). " +
      "Example: 'Show me LP positions for address 0xabc... on Base V4'",
    inputSchema: {
      chain: z.enum(V4_CHAIN_NAMES).describe("V4 chain key"),
      owner: z.string().optional().describe("Owner address to filter positions"),
      poolId: z.string().optional().describe("Pool address to filter positions"),
      limit: z.number().min(1).max(100).default(20).describe("Number of positions (1-100)"),
    },
  },
  async ({ chain, owner, poolId, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const where: string[] = [];
      if (owner) where.push(`origin: "${owner.toLowerCase()}"`);
      if (poolId) where.push(`pool: "${poolId.toLowerCase()}"`);
      const whereClause = where.length > 0 ? `where: { ${where.join(", ")} }` : "";

      // V4 Position entity lacks pool/tick/liquidity fields.
      // Use ModifyLiquidity events (which have full position data) as a proxy.
      const query = `{
        modifyLiquidities(
          first: ${limit}
          orderBy: timestamp
          orderDirection: desc
          ${whereClause}
        ) {
          id
          timestamp
          sender
          origin
          amount
          amount0
          amount1
          amountUSD
          tickLower
          tickUpper
          pool {
            id
            token0 { symbol name }
            token1 { symbol name }
            feeTier
            tick
          }
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const events = ((data.modifyLiquidities as Array<Record<string, unknown>>) ?? []).map((ev) => {
        const pool = ev.pool as Record<string, unknown>;
        const t0 = pool?.token0 as Record<string, unknown>;
        const t1 = pool?.token1 as Record<string, unknown>;
        const currentTick = Number(pool?.tick ?? 0);
        const tickLower = Number(ev.tickLower);
        const tickUpper = Number(ev.tickUpper);
        const inRange = currentTick >= tickLower && currentTick < tickUpper;
        const isAdd = Number(ev.amount ?? 0) > 0;

        ev._humanReadable = {
          pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
          feeTier: pool?.feeTier ? formatFeeTier(pool.feeTier as string) : "N/A",
          tickRange: `${tickLower} to ${tickUpper}`,
          inRange,
          type: isAdd ? "ADD" : "REMOVE",
          amountUSD: formatUSD(ev.amountUSD as string),
          time: new Date(Number(ev.timestamp) * 1000).toISOString(),
        };
        return ev;
      });

      return textResult({
        chain: cfg.name,
        version: "v4",
        filter: { owner: owner ?? "all", pool: poolId ?? "all" },
        positionCount: events.length,
        positions: events,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 24: get_flash_events (V3 only)
// ---------------------------------------------------------------------------
server.registerTool(
  "get_flash_events",
  {
    description:
      "Get recent flash loan events on Uniswap V3. Flash loans allow borrowing pool assets " +
      "within a single transaction. V3 only (V4 does not have a Flash entity). " +
      "Example: 'Show me recent flash loans on Ethereum V3'",
    inputSchema: {
      chain: z.enum(V3_CHAIN_NAMES).describe("V3 chain key"),
      poolId: z.string().optional().describe("Optional pool address to filter"),
      limit: z.number().min(1).max(100).default(20).describe("Number of events (1-100)"),
    },
  },
  async ({ chain, poolId, limit }) => {
    try {
      const cfg = getChainConfig(chain);
      const whereClause = poolId ? `where: { pool: "${poolId.toLowerCase()}" }` : "";

      const query = `{
        flashes(
          first: ${limit}
          orderBy: timestamp
          orderDirection: desc
          ${whereClause}
        ) {
          id
          timestamp
          pool { id token0 { symbol } token1 { symbol } feeTier }
          sender
          recipient
          amount0
          amount1
          amountUSD
          amount0Paid
          amount1Paid
          logIndex
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const flashes = ((data.flashes as Array<Record<string, unknown>>) ?? []).map((f) => {
        const pool = f.pool as Record<string, unknown>;
        const t0 = pool?.token0 as Record<string, unknown>;
        const t1 = pool?.token1 as Record<string, unknown>;
        f._humanReadable = {
          pair: `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`,
          value: formatUSD(f.amountUSD as string),
          borrowed0: formatNumber(f.amount0 as string) + " " + (t0?.symbol ?? ""),
          borrowed1: formatNumber(f.amount1 as string) + " " + (t1?.symbol ?? ""),
          paid0: formatNumber(f.amount0Paid as string) + " " + (t0?.symbol ?? ""),
          paid1: formatNumber(f.amount1Paid as string) + " " + (t1?.symbol ?? ""),
          time: formatTimestamp(f.timestamp as string),
        };
        return f;
      });

      return textResult({
        chain: cfg.name,
        version: "v3",
        flashCount: flashes.length,
        flashes,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 25: compare_token_cross_chain
// ---------------------------------------------------------------------------
server.registerTool(
  "compare_token_cross_chain",
  {
    description:
      "Compare a token's price, volume, TVL, and pool count across all Uniswap chains. " +
      "Useful for finding arbitrage opportunities or the best chain for a token. " +
      "Searches by symbol so it works across chains with different contract addresses. " +
      "Example: 'Compare USDC across all chains'",
    inputSchema: {
      tokenSymbol: z.string().describe("Token symbol to compare (e.g., 'USDC', 'WETH')"),
    },
  },
  async ({ tokenSymbol }) => {
    try {
      const results: Array<Record<string, unknown>> = [];

      // Query all chains in parallel
      const queries = Object.entries(CHAINS).map(async ([chainKey, cfg]) => {
        try {
          const bundleQuery = `{ bundle(id: "1") { ethPriceUSD } }`;
          const tokenQuery = `{
            tokens(
              first: 1
              where: { symbol: "${tokenSymbol}" }
              orderBy: totalValueLockedUSD
              orderDirection: desc
            ) {
              id
              symbol
              name
              volumeUSD
              totalValueLockedUSD
              txCount
              poolCount
              derivedETH
            }
          }`;

          const [bundleData, tokenData] = await Promise.all([
            querySubgraph(cfg.subgraphId, bundleQuery),
            querySubgraph(cfg.subgraphId, tokenQuery),
          ]);

          const ethPrice = Number(
            ((bundleData as Record<string, unknown>).bundle as Record<string, unknown>)?.ethPriceUSD ?? 0
          );
          const tokens = ((tokenData as Record<string, unknown>).tokens as Array<Record<string, unknown>>) ?? [];

          if (tokens.length > 0) {
            const token = tokens[0];
            const derivedETH = Number(token.derivedETH ?? 0);
            const priceUSD = derivedETH * ethPrice;
            results.push({
              chain: chainKey,
              chainName: cfg.name,
              version: cfg.version,
              tokenAddress: token.id,
              symbol: token.symbol,
              priceUSD,
              volumeUSD: Number(token.volumeUSD ?? 0),
              tvlUSD: Number(token.totalValueLockedUSD ?? 0),
              txCount: Number(token.txCount ?? 0),
              _humanReadable: {
                price: formatUSD(priceUSD),
                volume: formatUSD(token.volumeUSD as string),
                tvl: formatUSD(token.totalValueLockedUSD as string),
              },
            });
          }
        } catch {
          // Skip chains that error
        }
      });

      await Promise.all(queries);

      // Sort by TVL descending
      results.sort((a, b) => (b.tvlUSD as number) - (a.tvlUSD as number));

      // Price comparison
      const prices = results.filter((r) => (r.priceUSD as number) > 0);
      let priceSpread: Record<string, unknown> | undefined;
      if (prices.length >= 2) {
        const priceValues = prices.map((r) => r.priceUSD as number);
        const minPrice = Math.min(...priceValues);
        const maxPrice = Math.max(...priceValues);
        const spreadPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : 0;
        priceSpread = {
          lowestPrice: formatUSD(minPrice),
          lowestChain: prices.find((r) => r.priceUSD === minPrice)?.chainName,
          highestPrice: formatUSD(maxPrice),
          highestChain: prices.find((r) => r.priceUSD === maxPrice)?.chainName,
          spreadPercent: spreadPct.toFixed(4) + "%",
        };
      }

      return textResult({
        tokenSymbol,
        chainsFound: results.length,
        totalChains: Object.keys(CHAINS).length,
        priceSpread,
        chains: results,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 26: get_uniswap_schema
// ---------------------------------------------------------------------------
server.registerTool(
  "get_uniswap_schema",
  {
    description:
      "Introspect the full GraphQL schema for a Uniswap subgraph. " +
      "Returns all available entity types and their fields. " +
      "Use this when you need to construct custom queries. " +
      "Example: 'Show me the schema for Uniswap V4 on Base'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
    },
  },
  async ({ chain }) => {
    try {
      const cfg = getChainConfig(chain);
      const query = `{
        __schema {
          types {
            name
            kind
            fields {
              name
              type { name kind ofType { name kind } }
            }
          }
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const schema = data.__schema as Record<string, unknown>;
      const types = (schema?.types as Array<Record<string, unknown>>) ?? [];

      const entities = types.filter(
        (t) =>
          t.kind === "OBJECT" &&
          !(t.name as string).startsWith("__") &&
          !(t.name as string).endsWith("_filter") &&
          !(t.name as string).endsWith("_orderBy")
      );

      return textResult({
        chain: cfg.name,
        version: cfg.version,
        entityCount: entities.length,
        entities: entities.map((e) => ({
          name: e.name,
          fields: ((e.fields as Array<Record<string, unknown>>) ?? []).map((f) => {
            const fType = f.type as Record<string, unknown>;
            const ofType = fType?.ofType as Record<string, unknown> | undefined;
            return { name: f.name, type: ofType?.name ?? fType?.name ?? "unknown" };
          }),
        })),
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 16: query_uniswap_subgraph (escape hatch)
// ---------------------------------------------------------------------------
server.registerTool(
  "query_uniswap_subgraph",
  {
    description:
      "Execute a raw GraphQL query against any Uniswap subgraph. " +
      "This is the escape hatch for when pre-built tools don't cover your use case. " +
      "Use get_uniswap_schema first to discover available entities.",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      query: z.string().describe("Raw GraphQL query string"),
      variables: z.record(z.unknown()).optional().describe("Optional query variables"),
    },
  },
  async ({ chain, query, variables }) => {
    try {
      const cfg = getChainConfig(chain);
      const data = await querySubgraph(cfg.subgraphId, query, variables);
      return textResult({ chain: cfg.name, data });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_top_movers
// ---------------------------------------------------------------------------
server.registerTool(
  "get_top_movers",
  {
    description:
      "Get the top gaining and losing tokens by daily price change percentage. " +
      "Computes percentage change from open to close for each token in the most recent day's data. " +
      "Useful for finding today's biggest winners and losers on a chain. " +
      "Example: 'What are the top gainers and losers on Ethereum V3 today?'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      limit: z.number().min(1).max(50).default(10).describe("Number of tokens per category (1-50)"),
    },
  },
  async ({ chain, limit }) => {
    try {
      const cfg = getChainConfig(chain);

      // Get today's and yesterday's token day data
      const now = Math.floor(Date.now() / 1000);
      const todayStart = now - (now % 86400);
      const yesterdayStart = todayStart - 86400;

      const query = `{
        today: tokenDayDatas(
          first: 100
          orderBy: volumeUSD
          orderDirection: desc
          where: { date: ${todayStart}, volumeUSD_gt: "1000" }
        ) {
          token { id symbol name }
          date
          open
          close
          high
          low
          priceUSD
          volumeUSD
          totalValueLockedUSD
        }
        yesterday: tokenDayDatas(
          first: 100
          orderBy: volumeUSD
          orderDirection: desc
          where: { date: ${yesterdayStart}, volumeUSD_gt: "1000" }
        ) {
          token { id symbol name }
          date
          open
          close
          high
          low
          priceUSD
          volumeUSD
          totalValueLockedUSD
        }
      }`;

      const data = (await querySubgraph(cfg.subgraphId, query)) as Record<string, unknown>;
      const todayData = (data.today as Array<Record<string, unknown>>) ?? [];
      const yesterdayData = (data.yesterday as Array<Record<string, unknown>>) ?? [];

      // Use today's data if available, fall back to yesterday
      const dayData = todayData.length > 0 ? todayData : yesterdayData;
      const dateLabel = todayData.length > 0 ? "today" : "yesterday";
      const dateTimestamp = todayData.length > 0 ? todayStart : yesterdayStart;

      // Calculate % change and sort
      const withChange = dayData
        .map((d) => {
          const open = Number(d.open);
          const close = Number(d.close);
          const pctChange = open > 0 ? ((close - open) / open) * 100 : 0;
          const token = d.token as Record<string, unknown>;
          return {
            token: token.symbol,
            tokenName: token.name,
            tokenAddress: token.id,
            open: formatUSD(open),
            close: formatUSD(close),
            high: formatUSD(d.high as string),
            low: formatUSD(d.low as string),
            priceChangePercent: `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(2)}%`,
            _pctChange: pctChange,
            volume: formatUSD(d.volumeUSD as string),
            tvl: formatUSD(d.totalValueLockedUSD as string),
          };
        })
        .filter((d) => isFinite(d._pctChange) && d._pctChange !== 0);

      const gainers = [...withChange]
        .sort((a, b) => b._pctChange - a._pctChange)
        .slice(0, limit)
        .map(({ _pctChange, ...rest }) => rest);

      const losers = [...withChange]
        .sort((a, b) => a._pctChange - b._pctChange)
        .slice(0, limit)
        .map(({ _pctChange, ...rest }) => rest);

      return textResult({
        chain: cfg.name,
        period: dateLabel,
        date: new Date(dateTimestamp * 1000).toISOString().slice(0, 10),
        gainers,
        losers,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_trending_tokens
// ---------------------------------------------------------------------------
server.registerTool(
  "get_trending_tokens",
  {
    description:
      "Find trending tokens based on recent volume growth compared to the previous day. " +
      "Compares today's trading volume to yesterday's to identify tokens with surging activity. " +
      "Also returns the most actively traded tokens (by transaction count). " +
      "Example: 'What tokens are trending on Base V3?'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      limit: z.number().min(1).max(50).default(15).describe("Number of tokens to return (1-50)"),
    },
  },
  async ({ chain, limit }) => {
    try {
      const cfg = getChainConfig(chain);

      const now = Math.floor(Date.now() / 1000);
      const todayStart = now - (now % 86400);
      const yesterdayStart = todayStart - 86400;

      const [todayResult, yesterdayResult, topByPoolsResult] = await Promise.all([
        querySubgraph(cfg.subgraphId, `{
          tokenDayDatas(
            first: 100
            orderBy: volumeUSD
            orderDirection: desc
            where: { date: ${todayStart}, volumeUSD_gt: "100" }
          ) {
            token { id symbol name totalValueLockedUSD }
            volumeUSD
          }
        }`),
        querySubgraph(cfg.subgraphId, `{
          tokenDayDatas(
            first: 100
            orderBy: volumeUSD
            orderDirection: desc
            where: { date: ${yesterdayStart}, volumeUSD_gt: "100" }
          ) {
            token { id symbol name }
            volumeUSD
          }
        }`),
        querySubgraph(cfg.subgraphId, `{
          tokens(
            first: ${limit}
            orderBy: txCount
            orderDirection: desc
            where: { totalValueLockedUSD_gt: "100", txCount_gt: "100" }
          ) {
            id symbol name txCount totalValueLockedUSD volumeUSD
          }
        }`),
      ]);

      const todayData = ((todayResult as Record<string, unknown>).tokenDayDatas as Array<Record<string, unknown>>) ?? [];
      const yesterdayData = ((yesterdayResult as Record<string, unknown>).tokenDayDatas as Array<Record<string, unknown>>) ?? [];
      const topByPools = ((topByPoolsResult as Record<string, unknown>).tokens as Array<Record<string, unknown>>) ?? [];

      // Build yesterday volume lookup
      const yesterdayVolume: Record<string, number> = {};
      for (const d of yesterdayData) {
        const token = d.token as Record<string, unknown>;
        yesterdayVolume[token.id as string] = Number(d.volumeUSD);
      }

      // Compute volume growth
      const volumeGrowth = todayData
        .map((d) => {
          const token = d.token as Record<string, unknown>;
          const todayVol = Number(d.volumeUSD);
          const yesterdayVol = yesterdayVolume[token.id as string] ?? 0;
          const growthPct = yesterdayVol > 0 ? ((todayVol - yesterdayVol) / yesterdayVol) * 100 : 0;
          return {
            token: token.symbol,
            tokenName: token.name,
            tokenAddress: token.id,
            todayVolume: formatUSD(todayVol),
            yesterdayVolume: formatUSD(yesterdayVol),
            volumeGrowth: yesterdayVol > 0
              ? `${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}%`
              : "new",
            tvl: formatUSD(token.totalValueLockedUSD as string),
            _growth: growthPct,
          };
        })
        .filter((d) => d._growth > 0 || d.volumeGrowth === "new")
        .sort((a, b) => b._growth - a._growth)
        .slice(0, limit)
        .map(({ _growth, ...rest }) => rest);

      const mostActive = topByPools.map((t) => ({
        token: t.symbol,
        tokenName: t.name,
        tokenAddress: t.id,
        txCount: formatNumber(t.txCount as string),
        tvl: formatUSD(t.totalValueLockedUSD as string),
        totalVolume: formatUSD(t.volumeUSD as string),
      }));

      return textResult({
        chain: cfg.name,
        date: new Date(todayStart * 1000).toISOString().slice(0, 10),
        volumeSurge: volumeGrowth,
        mostActive,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 30: get_token_price_history
// ---------------------------------------------------------------------------
server.registerTool(
  "get_token_price_history",
  {
    description:
      "Get historical daily price data for a token by symbol (no address needed). " +
      "Resolves the token symbol to an address automatically, then returns OHLC price history. " +
      "Easier than get_token_day_data when you don't know the contract address. " +
      "Example: 'Show me PEPE price history on Ethereum V3 for the last 30 days'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      tokenSymbol: z.string().describe("Token symbol (e.g., 'PEPE', 'WETH', 'USDC')"),
      days: z.number().min(1).max(365).default(30).describe("Number of days of history (1-365)"),
    },
  },
  async ({ chain, tokenSymbol, days }) => {
    try {
      const cfg = getChainConfig(chain);

      // Resolve symbol to address (pick highest-TVL match)
      const resolveQuery = `{
        tokens(
          first: 1
          where: { symbol_contains_nocase: "${tokenSymbol}" }
          orderBy: totalValueLockedUSD
          orderDirection: desc
        ) { id symbol name totalValueLockedUSD derivedETH }
      }`;
      const resolveData = (await querySubgraph(cfg.subgraphId, resolveQuery)) as Record<string, unknown>;
      const tokens = (resolveData.tokens as Array<Record<string, unknown>>) ?? [];
      if (tokens.length === 0) {
        return textResult({ error: `No token matching "${tokenSymbol}" found on ${cfg.name}` });
      }
      const token = tokens[0];
      const tokenAddress = (token.id as string).toLowerCase();

      // Get ETH price for USD conversion
      const bundleQuery = `{ bundle(id: "1") { ethPriceUSD } }`;

      // Get day data
      const dayQuery = `{
        tokenDayDatas(
          first: ${days}
          orderBy: date
          orderDirection: desc
          where: { token: "${tokenAddress}" }
        ) {
          date
          priceUSD
          open
          high
          low
          close
          volumeUSD
          totalValueLockedUSD
        }
      }`;

      const [bundleData, dayData] = await Promise.all([
        querySubgraph(cfg.subgraphId, bundleQuery),
        querySubgraph(cfg.subgraphId, dayQuery),
      ]);

      const ethPrice = Number(
        ((bundleData as Record<string, unknown>).bundle as Record<string, unknown>)?.ethPriceUSD ?? 0
      );
      const derivedETH = Number(token.derivedETH ?? 0);
      const currentPriceUSD = derivedETH * ethPrice;

      const dayDatas = ((dayData as Record<string, unknown>).tokenDayDatas as Array<Record<string, unknown>>) ?? [];
      const formatted = dayDatas.map((d) => ({
        date: new Date(Number(d.date) * 1000).toISOString().slice(0, 10),
        open: formatUSD(d.open as string),
        high: formatUSD(d.high as string),
        low: formatUSD(d.low as string),
        close: formatUSD(d.close as string),
        volume: formatUSD(d.volumeUSD as string),
        tvl: formatUSD(d.totalValueLockedUSD as string),
      }));

      // Compute summary stats
      const closes = dayDatas.map((d) => Number(d.close)).filter((n) => n > 0);
      const highs = dayDatas.map((d) => Number(d.high)).filter((n) => n > 0);
      const lows = dayDatas.map((d) => Number(d.low)).filter((n) => n > 0);

      const summary: Record<string, unknown> = {
        currentPrice: formatUSD(currentPriceUSD),
        daysReturned: formatted.length,
      };
      if (closes.length >= 2) {
        const oldest = closes[closes.length - 1];
        const newest = closes[0];
        const changePct = oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;
        summary.periodChange = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
      }
      if (highs.length > 0) summary.periodHigh = formatUSD(Math.max(...highs));
      if (lows.length > 0) summary.periodLow = formatUSD(Math.min(...lows));

      return textResult({
        chain: cfg.name,
        token: token.symbol,
        tokenName: token.name,
        tokenAddress,
        summary,
        priceHistory: formatted,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 31: get_pool_concentration
// ---------------------------------------------------------------------------
server.registerTool(
  "get_pool_concentration",
  {
    description:
      "Analyze liquidity concentration around the current price for a pool. " +
      "Shows how liquidity is distributed across tick ranges near the active tick. " +
      "Useful for understanding if liquidity is tightly concentrated or spread out, " +
      "which affects slippage and LP returns. " +
      "Example: 'Show me liquidity concentration for the ETH/USDC 0.3% pool on Ethereum V3'",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain key"),
      poolId: z.string().describe("Pool address"),
      tickRange: z.number().min(100).max(50000).default(5000).describe(
        "How many ticks above and below current tick to analyze (default 5000, ~65% price range for 0.3% pool)"
      ),
    },
  },
  async ({ chain, poolId, tickRange }) => {
    try {
      const cfg = getChainConfig(chain);

      // Get pool details + ticks in parallel
      const poolQuery = `{
        pool(id: "${poolId.toLowerCase()}") {
          id
          tick
          sqrtPrice
          liquidity
          feeTier
          token0 { id symbol name decimals }
          token1 { id symbol name decimals }
          token0Price
          token1Price
          totalValueLockedUSD
          totalValueLockedToken0
          totalValueLockedToken1
        }
      }`;

      const poolData = (await querySubgraph(cfg.subgraphId, poolQuery)) as Record<string, unknown>;
      const pool = poolData.pool as Record<string, unknown>;
      if (!pool) {
        return textResult({ error: `Pool ${poolId} not found on ${cfg.name}` });
      }

      const currentTick = Number(pool.tick);
      const lowerBound = currentTick - tickRange;
      const upperBound = currentTick + tickRange;

      const ticksQuery = `{
        ticks(
          first: 500
          orderBy: tickIdx
          orderDirection: asc
          where: {
            pool: "${poolId.toLowerCase()}"
            tickIdx_gte: ${lowerBound}
            tickIdx_lte: ${upperBound}
          }
        ) {
          tickIdx
          liquidityGross
          liquidityNet
          price0
          price1
        }
      }`;

      const ticksData = (await querySubgraph(cfg.subgraphId, ticksQuery)) as Record<string, unknown>;
      const ticks = ((ticksData.ticks as Array<Record<string, unknown>>) ?? []);

      const t0 = pool.token0 as Record<string, unknown>;
      const t1 = pool.token1 as Record<string, unknown>;
      const pair = `${t0?.symbol ?? "?"}/${t1?.symbol ?? "?"}`;

      // Analyze concentration: split ticks into bands around current price
      const bandSize = Math.max(Math.floor(tickRange / 5), 1);
      const bands: Array<Record<string, unknown>> = [];

      for (let i = -5; i < 5; i++) {
        const bandLower = currentTick + i * bandSize;
        const bandUpper = currentTick + (i + 1) * bandSize;
        const bandTicks = ticks.filter((t) => {
          const idx = Number(t.tickIdx);
          return idx >= bandLower && idx < bandUpper;
        });
        const totalLiquidityGross = bandTicks.reduce(
          (sum, t) => sum + Math.abs(Number(t.liquidityGross ?? 0)),
          0
        );
        const tickCount = bandTicks.length;

        // Price at band boundaries (approximate from tick)
        const priceLower = Math.pow(1.0001, bandLower);
        const priceUpper = Math.pow(1.0001, bandUpper);

        bands.push({
          range: i === 0 ? "ACTIVE" : i < 0 ? `${Math.abs(i)} below` : `${i} above`,
          tickRange: `${bandLower} to ${bandUpper}`,
          priceRange: `${formatNumber(priceLower)} to ${formatNumber(priceUpper)}`,
          initializedTicks: tickCount,
          liquidityGross: totalLiquidityGross.toExponential(2),
          isCurrentBand: i === 0,
        });
      }

      // Summary stats
      const totalGrossLiquidity = ticks.reduce(
        (sum, t) => sum + Math.abs(Number(t.liquidityGross ?? 0)),
        0
      );
      const innerTicks = ticks.filter((t) => {
        const idx = Number(t.tickIdx);
        return idx >= currentTick - bandSize && idx < currentTick + bandSize;
      });
      const innerLiquidity = innerTicks.reduce(
        (sum, t) => sum + Math.abs(Number(t.liquidityGross ?? 0)),
        0
      );
      const concentrationRatio = totalGrossLiquidity > 0
        ? ((innerLiquidity / totalGrossLiquidity) * 100).toFixed(1) + "%"
        : "N/A";

      return textResult({
        chain: cfg.name,
        pool: {
          pair,
          feeTier: formatFeeTier(pool.feeTier as string),
          currentTick,
          token0Price: formatNumber(pool.token0Price as string),
          token1Price: formatNumber(pool.token1Price as string),
          tvl: formatUSD(pool.totalValueLockedUSD as string),
          activeLiquidity: pool.liquidity,
        },
        analysis: {
          ticksAnalyzed: ticks.length,
          rangeAnalyzed: `${tickRange} ticks above and below current price`,
          concentrationRatio,
          concentrationNote:
            `${concentrationRatio} of gross liquidity is within the innermost band (1/10 of analyzed range). ` +
            "Higher concentration means tighter liquidity around current price (lower slippage, higher LP fee capture).",
        },
        bands,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

server.registerPrompt(
  "pool_analysis",
  {
    description: "Analyze a Uniswap pool's health, activity, and key metrics",
    argsSchema: {
      chain: z.string().describe("Chain key (e.g., 'ethereum-v3')"),
      poolId: z.string().describe("Pool address"),
    },
  },
  ({ chain, poolId }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Perform a comprehensive analysis of Uniswap pool ${poolId} on ${chain}.\n\n` +
            `Steps:\n` +
            `1. Call get_pool_details for the pool\n` +
            `2. Call get_pool_day_data with 30 days of history\n` +
            `3. Call get_recent_swaps filtered to this pool (20 swaps)\n` +
            `4. Call get_pool_ticks to understand liquidity distribution\n` +
            `5. Call get_recent_liquidity_events filtered to this pool\n\n` +
            `Synthesize: pool overview, fee APR estimate (daily fees / TVL * 365), ` +
            `volume trend, liquidity concentration, LP behavior, whale activity, overall health.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "token_overview",
  {
    description: "Get a comprehensive overview of a token across Uniswap",
    argsSchema: {
      chain: z.string().describe("Chain key"),
      tokenSymbol: z.string().describe("Token symbol"),
    },
  },
  ({ chain, tokenSymbol }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Comprehensive overview of ${tokenSymbol} on Uniswap (${chain}).\n\n` +
            `Steps:\n` +
            `1. Call get_token_info for current price, volume, TVL, pool count\n` +
            `2. Call search_pools_by_token to find all pools (top 10 by TVL)\n` +
            `3. Call get_token_day_data for 30 days of price history\n` +
            `4. Call get_eth_price for accurate USD values\n\n` +
            `Synthesize: token profile, liquidity map, volume trends, ` +
            `price trend (30-day high/low/current), best pool recommendation.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "whale_watch",
  {
    description: "Monitor large trades and unusual activity on a chain",
    argsSchema: {
      chain: z.string().describe("Chain key"),
      minUSD: z.string().default("100000").describe("Minimum USD threshold"),
    },
  },
  ({ chain, minUSD }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Whale watch analysis on Uniswap (${chain}).\n\n` +
            `Steps:\n` +
            `1. Call get_large_swaps with minAmountUSD=${minUSD} and limit=50\n` +
            `2. Call get_protocol_day_data for the last 7 days\n` +
            `3. Call get_top_pools by volumeUSD\n\n` +
            `Analyze: largest swaps, repeat addresses, which pools see whale activity, ` +
            `directional patterns, unusual activity, smart money direction.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "liquidity_analysis",
  {
    description: "Analyze LP behavior and liquidity trends",
    argsSchema: {
      chain: z.string().describe("Chain key"),
    },
  },
  ({ chain }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Analyze LP behavior and liquidity trends on Uniswap (${chain}).\n\n` +
            `Steps:\n` +
            `1. Call get_top_pools by TVL (top 10)\n` +
            `2. Call get_recent_liquidity_events (50 events)\n` +
            `3. Call get_protocol_day_data for 30 days\n\n` +
            `Analyze: TVL trend, net liquidity flow, which pools gaining/losing, ` +
            `LP concentration, fee tier preferences, risk signals.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "market_overview",
  {
    description: "Full cross-chain Uniswap market overview",
    argsSchema: {},
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Full market overview across all Uniswap deployments.\n\n` +
            `Call get_protocol_stats for each chain:\n` +
            Object.keys(CHAINS).map((k) => `- ${k}`).join("\n") +
            `\n\nSynthesize: total TVL, chain-by-chain comparison (TVL, volume, pool count), ` +
            `V3 vs V4 adoption, fastest growing chain, ETH price comparison, ecosystem health.`,
        },
      },
    ],
  })
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
