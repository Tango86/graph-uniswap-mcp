#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { querySubgraph } from "./graphClient.js";
import {
  CHAINS,
  CHAIN_NAMES,
  getChainConfig,
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
        result._humanReadable = {
          totalPools: formatNumber(s.poolCount as string),
          totalVolume: formatUSD(s.totalVolumeUSD as string),
          totalFees: formatUSD(s.totalFeesUSD as string),
          tvl: formatUSD(s.totalValueLockedUSD as string),
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
          where: { totalValueLockedUSD_gt: "100" }
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
        token0Price: `1 ${t0?.symbol} = ${formatNumber(pool.token0Price as string)} ${t1?.symbol}`,
        token1Price: `1 ${t1?.symbol} = ${formatNumber(pool.token1Price as string)} ${t0?.symbol}`,
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

      const query = `{
        swaps(
          first: ${limit}
          orderBy: amountUSD
          orderDirection: desc
          where: { amountUSD_gte: "${minAmountUSD}" }
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
          modifyLiquiditys(
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
        const events = ((data.modifyLiquiditys as Array<Record<string, unknown>>) ?? []).map((ev) => {
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
          poolCount: token.poolCount,
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
          date: new Date(Number(d.date) * 86400 * 1000).toISOString().slice(0, 10),
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
          date: new Date(Number(d.date) * 86400 * 1000).toISOString().slice(0, 10),
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
// Tool 13: get_eth_price
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
      const query = `{
        uniswapDayDatas(
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
      const dayDatas = ((data.uniswapDayDatas as Array<Record<string, unknown>>) ?? []).map((d) => {
        d._humanReadable = {
          date: new Date(Number(d.date) * 86400 * 1000).toISOString().slice(0, 10),
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
// Tool 15: get_uniswap_schema
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
