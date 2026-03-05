# graph-uniswap-mcp

MCP server for querying Uniswap V3/V4 DEX data via The Graph's decentralized network.

16 tools, 5 guided prompts. 5 chains, 9 subgraphs. Pools, swaps, prices, liquidity, whale tracking, and more.

## Supported Chains

| Chain | V3 | V4 |
|-------|----|----|
| Ethereum | Yes | Yes |
| Base | Yes | Yes |
| Arbitrum | Yes | Yes |
| Polygon | Yes | Yes |
| Optimism | Yes | - |

## Setup (30 seconds)

1. Get a free API key from [Subgraph Studio](https://thegraph.com/studio/apikeys/)

2. Add to your MCP client config:

```json
{
  "mcpServers": {
    "graph-uniswap": {
      "command": "npx",
      "args": ["-y", "graph-uniswap-mcp"],
      "env": {
        "GRAPH_API_KEY": "your-api-key"
      }
    }
  }
}
```

Works with Claude Desktop, Cursor, Cline, and any MCP-compatible client.

## Tools

### Discovery
- **list_uniswap_chains** - List all supported chains and versions
- **search_pools_by_token** - Find pools by token symbol or address
- **get_uniswap_schema** - Introspect the GraphQL schema

### Protocol Stats
- **get_protocol_stats** - Global stats (TVL, volume, fees, pool count)
- **get_protocol_day_data** - Daily protocol metrics over time
- **get_eth_price** - Current ETH/USD price from Uniswap pools

### Pool Analytics
- **get_top_pools** - Top pools by TVL, volume, or fees
- **get_pool_details** - Deep dive on a single pool
- **get_pool_day_data** - Historical daily OHLC + volume + fees for a pool
- **get_pool_ticks** - Liquidity distribution across price ticks

### Token Data
- **get_token_info** - Token price, volume, TVL, pool count
- **get_token_day_data** - Historical daily OHLC price data

### Trading Activity
- **get_recent_swaps** - Recent swaps (optional pool filter)
- **get_large_swaps** - Whale trade monitoring above a USD threshold

### Liquidity
- **get_recent_liquidity_events** - Recent mint/burn (V3) or ModifyLiquidity (V4) events

### Escape Hatch
- **query_uniswap_subgraph** - Run any raw GraphQL query

## Guided Prompts

| Prompt | Description |
|--------|-------------|
| **pool_analysis** | Comprehensive pool health check: TVL, fees, volume trends, LP behavior, tick distribution |
| **token_overview** | Full token profile: price, pools, volume history, best pool recommendation |
| **whale_watch** | Monitor large trades, detect patterns, identify smart money direction |
| **liquidity_analysis** | LP behavior trends, TVL flow, fee tier preferences, risk signals |
| **market_overview** | Cross-chain comparison of all Uniswap deployments |

## Example Prompts

```
"What are the top 10 pools on Uniswap V3 Ethereum by TVL?"
"Show me whale trades over $500K on Base V4"
"Get WETH token info and price history on Arbitrum"
"What is the current ETH price across all chains?"
"Analyze the ETH/USDC 0.05% pool on Ethereum"
"Show me recent liquidity events on Base V4"
"Run a whale watch analysis on Arbitrum V3"
```

## V3 vs V4 Differences

| Feature | V3 | V4 |
|---------|----|----|
| Protocol entity | Factory | PoolManager |
| Liquidity events | Mint + Burn | ModifyLiquidity |
| Pool fields | Standard | + hooks, tickSpacing, isExternalLiquidity |
| Positions | Via events | Position entity with tokenId |
| Swap recipient | Included | Not included |

## Data Source

All data is queried from Uniswap's official subgraphs deployed on The Graph's decentralized network. Every query generates fees for Indexers on the network.

- V3 subgraphs: [Uniswap docs](https://docs.uniswap.org/api/subgraph/overview)
- V4 subgraphs: [Graph Explorer](https://thegraph.com/explorer)

## License

MIT
