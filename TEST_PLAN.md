# graph-uniswap-mcp + graph-lido-mcp Test Plan

Follows the [MCP Server Testing Standard](../../.claude/projects/-Users-aclews-coding/memory/mcp-test-standard.md). Test scenarios designed from real user intent research (LP yield optimization, whale tracking, cross-chain arbitrage, staking decisions).

## Round 1: LP (Liquidity Provider) Questions

The #1 use case. LPs want to find profitable pools, assess risk, and monitor positions.

| # | User Question | Tools Required | Pass Criteria | Brittleness |
|---|---------------|----------------|---------------|-------------|
| 1.1 | "What's the best pool to LP into on Ethereum right now?" | `get_top_pools` (by feesUSD), `get_pool_fee_apr` | Returns real pools with >10% APR, no spam | Medium - spam filter dependent |
| 1.2 | "How much would I earn providing $10K liquidity to ETH/USDC 0.05%?" | `get_pool_fee_apr`, `get_pool_details` | APR * $10K calculation possible, valid dates | Low |
| 1.3 | "Is there more yield on Base or Ethereum for ETH/USDC?" | `search_pools_by_token` (both chains), `get_pool_fee_apr` (both) | Returns comparable pools on both chains, APR comparison | Medium - pool addresses differ per chain |
| 1.4 | "Show me the liquidity distribution for the main ETH/USDC pool" | `get_pool_ticks` | Returns tick data with liquidityNet values, not empty | Medium - tick queries can be large |
| 1.5 | "What's the impermanent loss risk if ETH drops 20%?" | `get_pool_details`, `simulate_swap` | Pool price data available for IL calculation | Low - math is on the LLM side |

## Round 2: Trader Questions

Traders want price info, whale signals, and execution estimates.

| # | User Question | Tools Required | Pass Criteria | Brittleness |
|---|---------------|----------------|---------------|-------------|
| 2.1 | "What's the current ETH price?" | `get_eth_price` | Returns price ~$2K range, not 0 or null | Low |
| 2.2 | "How much slippage would I get swapping 100 ETH for USDC?" | `simulate_swap` | Returns ~$209K USDC, <0.1% impact, `insufficientLiquidity=false` | Low |
| 2.3 | "Show me whale trades over $1M in the last day" | `get_large_swaps` (minAmountUSD=1000000) | Returns trades with USD values >$1M | Medium - sorts by amountUSD desc, may be historical |
| 2.4 | "Is anyone front-running this pool?" | `get_recent_swaps` (poolId filter) | Returns swaps with timestamps, senders, amounts | Low |
| 2.5 | "What tokens are pumping right now?" | `get_trending_tokens` | volumeSurge array with >50% growth tokens, mostActive with txCounts | Low |
| 2.6 | "Can I get a better price on Arbitrum vs Ethereum for USDC/ETH?" | `simulate_swap` (both chains) | Both return non-zero results, comparable prices | High - need correct pool IDs per chain |

## Round 3: New Chain Validation

Testing the 4 new chains (BSC, Avalanche, Celo, Blast) work correctly.

| # | User Question | Tools Required | Pass Criteria | Brittleness |
|---|---------------|----------------|---------------|-------------|
| 3.1 | "What are the top pools on BNB Chain?" | `get_top_pools` (bsc-v3) | Returns pools with BNB-native tokens (WBNB, BUSD, CAKE), no errors | High - untested subgraph |
| 3.2 | "What's the ETH price on Avalanche?" | `get_eth_price` (avalanche-v3) | Returns AVAX price (not ETH), clearly labeled | High - ethPriceUSD = native token |
| 3.3 | "Show me protocol stats for Celo" | `get_protocol_stats` (celo-v3) | Returns valid poolCount, TVL, volume. No GraphQL errors | High - low activity chain |
| 3.4 | "What tokens are trending on Blast?" | `get_trending_tokens` (blast-v3) | Returns tokens or empty (valid). No crash | High - may have low activity |
| 3.5 | "Compare USDC across all chains" | `compare_token_cross_chain` | Now includes BSC, Avalanche, Celo, Blast in results | Medium - some chains may not have USDC |
| 3.6 | "Search for WBNB pools on BNB Chain" | `search_pools_by_token` (bsc-v3, WBNB) | Returns WBNB pools ranked by TVL | High - symbol may differ |
| 3.7 | "Get recent swaps on Avalanche" | `get_recent_swaps` (avalanche-v3) | Returns swaps with timestamps and USD values | High - untested |
| 3.8 | "What's the fee APR on the top Blast pool?" | `get_top_pools` then `get_pool_fee_apr` (blast-v3) | Returns valid APR or clear error if no pool day data | High - newer chain |

## Round 4: Lido Staker Questions

Users want yield info, risk assessment, and withdrawal timing.

| # | User Question | Tools Required | Pass Criteria | Brittleness |
|---|---------------|----------------|---------------|-------------|
| 4.1 | "What's the current Lido staking APR?" | `get_staking_apr` | Returns ~2.4-3.5% APR with fee breakdown | Low |
| 4.2 | "Is staking paused or in bunker mode?" | `get_lido_stats` | Returns `isStopped: false`, `isBunkerMode: false` | Low |
| 4.3 | "How long is the withdrawal queue?" | `get_withdrawal_requests`, `get_lido_stats` | Queue status + recent requests with timestamps | Low |
| 4.4 | "Who are the biggest stETH holders?" | `get_top_holders` | wstETH contract #1 at ~46%, ranked list | Low |
| 4.5 | "How much stETH does address 0x... hold?" | `get_holder_shares` | Returns shares + stETH balance, or "not found" | Low |
| 4.6 | "Are any node operators having problems?" | `get_node_operators` | Returns operators, check for stopped validators > 0 | Low |
| 4.7 | "What's the stETH/ETH ratio trend?" | `get_steth_ratio_history` | Returns ratio over time, should be >1.0 and rising | Medium |
| 4.8 | "Show me net staking flow - is more ETH entering or leaving?" | `get_staking_net_flow` | Returns net flow with clear direction | Medium |
| 4.9 | "What governance votes are happening?" | `get_governance_votes`, `get_easytrack_motions` | Returns votes with metadata, execution status | Low |
| 4.10 | "How much ETH was withdrawn last week?" | `get_withdrawal_claims` | Returns claimed amounts with dates | Low |

## Round 5: Cross-Tool Workflows

Multi-step questions that require combining data from several tools.

| # | User Question | Tools Required | Pass Criteria | Brittleness |
|---|---------------|----------------|---------------|-------------|
| 5.1 | "Full analysis of the ETH/USDC 0.05% pool on Ethereum" | `get_pool_details` + `get_pool_fee_apr` + `get_pool_ticks` + `get_recent_swaps` (poolId) | All 4 return data for same pool, coherent picture | Medium |
| 5.2 | "Compare Uniswap V3 vs V4 on Ethereum" | `get_protocol_stats` (ethereum-v3) + `get_protocol_stats` (ethereum-v4) | Both return stats, V3 >> V4 in volume (expected) | Low |
| 5.3 | "Market overview across all chains" | `get_protocol_stats` (all 13 chains) | All return valid data, can rank by TVL/volume | High - 13 parallel calls |
| 5.4 | "Is this a good time to stake with Lido?" | `get_staking_apr` + `get_lido_stats` + `get_staking_net_flow` | APR trend + queue status + flow direction | Medium |
| 5.5 | "Find arbitrage between ETH/USDC on different chains" | `compare_token_cross_chain` (WETH) + `simulate_swap` (multiple chains) | Price differences visible, swap estimates available | High |

## Round 6: Edge Cases & Brittleness

Scenarios designed to break things.

| # | Scenario | Tool | Pass Criteria | Expected Brittleness |
|---|----------|------|---------------|---------------------|
| 6.1 | Nonexistent pool address | `get_pool_details` | Graceful error, not crash | Medium |
| 6.2 | Token with no pools | `search_pools_by_token` (obscure symbol) | Empty results, not error | Low |
| 6.3 | Very large trade simulation (100K ETH) | `simulate_swap` | `insufficientLiquidity: true` or very high impact | Medium |
| 6.4 | Pool with 0 TVL | `get_pool_fee_apr` | Handles division by zero gracefully | High |
| 6.5 | V4 chain with no activity | `get_positions` (polygon-v4) | Empty or minimal results, no crash | Medium |
| 6.6 | Same tool called twice rapidly | Any tool | Second call returns cached result (60s TTL) | Low |
| 6.7 | Chain with ethPriceUSD = native token | `get_eth_price` (bsc-v3, avalanche-v3) | Returns native token price, user isn't confused | High - labeling issue |
| 6.8 | Raw GraphQL query with typo | `query_uniswap_subgraph` | Returns GraphQL error message, not crash | Low |
| 6.9 | get_pool_fee_apr with days=90 | `get_pool_fee_apr` | Returns 90 days of data or as many as available | Medium |
| 6.10 | Lido holder lookup for contract address | `get_holder_shares` | Returns balance for contracts (wstETH, Aave, etc.) | Low |

## Priority Order for Testing

1. **Round 3 (New Chains)** - highest risk, completely untested subgraphs
2. **Round 6 (Edge Cases)** - find crashes before users do
3. **Round 1 (LP Questions)** - highest-value user persona
4. **Round 2 (Trader Questions)** - second-highest value
5. **Round 4 (Lido Staker)** - separate server, mostly validated
6. **Round 5 (Cross-Tool)** - depends on individual tools passing first

---

## Test Results (2026-03-05)

### Fix Verification

| Fix | Description | Result | Notes |
|-----|-------------|--------|-------|
| Fix 1 | `get_large_swaps` time-scoping (24h) | PASS | All 5 results from 2026-03-05. No more 2022-era swaps. |
| Fix 2 | `compare_token_cross_chain` exact match | PASS | WETH search returns only `symbol: "WETH"` across 9 chains. No spWETH/RDNT-WETH contamination. |
| Fix 3 | `get_protocol_stats` negative TVL guard | PASS | ethereum-v4 TVL shows `"N/A (data unavailable)"` with `totalValueLockedUSD: "0"`. No -$482T. |
| Fix 4 | Friendlier indexer errors | PASS | BSC V3 returns `"Subgraph indexers are temporarily unavailable"` instead of raw JSON. |
| Fix 5 | "no allocations" error handling (added during testing) | BUILT | Added to both Uniswap and Lido graphClient.ts. Requires server restart to verify. |

### Round 3: New Chain Validation

| # | Test | Result | Notes |
|---|------|--------|-------|
| 3.1 | `get_top_pools` on bsc-v3 | BLOCKED | BSC V3 subgraph indexers temporarily unavailable (network-level issue, not our code). `get_protocol_stats` works (15.48K pools, $77.25M TVL, BNB $647.93). |
| 3.2 | `get_eth_price` on avalanche-v3 | PASS | Returns $9.40 (AVAX native token price, reasonable). |
| 3.3 | `get_protocol_stats` on celo-v3 | PASS | 657 pools, $8.38M TVL, $9.14B total volume. Valid data. |
| 3.4 | `get_trending_tokens` on blast-v3 | BLOCKED | "subgraph not found: no allocations" - no Indexers allocated to Blast subgraph. Added "no allocations" to friendly error handler (Fix 5). |
| 3.5 | `compare_token_cross_chain` USDC | PASS | 9 chains found including BSC ($2.48M TVL), Avalanche ($3.15M TVL), Celo ($413K TVL). New chains included. |
| 3.6 | `search_pools_by_token` on bsc-v3 | BLOCKED | Same BSC indexer issue as 3.1. |
| 3.7 | `get_recent_swaps` on avalanche-v3 | PASS | Returns 5 swaps from 2026-03-05, native WAVAX pairs (WBTC.e/WAVAX, WETH.e/WAVAX, ZRO/WAVAX). |
| 3.8 | `get_top_pools` + `get_pool_fee_apr` on blast-v3 | BLOCKED | Same Blast allocation issue as 3.4. |

### Round 4: Lido Smoke Test

| # | Test | Result | Notes |
|---|------|--------|-------|
| 4.1 | `get_staking_apr` | PASS | APR ~2.44% (2026-03-05), daily reports with ETH rewards (607.9 ETH), MEV fees (47.2 ETH), operator breakdown. |

### Summary

- **Fixes:** 4/4 verified, 1 additional fix added (Fix 5: "no allocations" error handling)
- **New chains:** 4/8 PASS, 4/8 BLOCKED by network-level subgraph issues (BSC bad indexers, Blast no allocations)
- **Blocked tests are infrastructure issues, not code bugs.** BSC `get_protocol_stats` works fine, confirming our subgraph IDs are correct.
- **Lido:** Healthy, APR reporting correctly.
- **Additional fix applied to Lido:** Friendly indexer error handler added to `graph-lido-mcp/src/graphClient.ts`.
