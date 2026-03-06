export class GraphClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly graphErrors?: unknown[]
  ) {
    super(message);
    this.name = "GraphClientError";
  }
}

// Simple TTL cache to reduce redundant queries and save API fees
interface CacheEntry {
  data: unknown;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 60_000; // 60 seconds

function getCacheKey(subgraphId: string, query: string, variables?: Record<string, unknown>): string {
  return `${subgraphId}:${query}:${variables ? JSON.stringify(variables) : ""}`;
}

function getFromCache(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function setInCache(key: string, data: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
  // Cap cache size to prevent memory leaks
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiry) cache.delete(k);
    }
    // If still too large, clear oldest half
    if (cache.size > 500) {
      const keys = Array.from(cache.keys());
      for (let i = 0; i < keys.length / 2; i++) {
        cache.delete(keys[i]);
      }
    }
  }
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

export async function querySubgraph(
  subgraphId: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    throw new GraphClientError(
      "GRAPH_API_KEY environment variable is required. " +
        "Get one free at https://thegraph.com/studio/apikeys/"
    );
  }

  // Check cache first
  const cacheKey = getCacheKey(subgraphId, query, variables);
  const cached = getFromCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;

  const body: Record<string, unknown> = { query };
  if (variables && Object.keys(variables).length > 0) {
    body.variables = variables;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new GraphClientError(
      `Graph API returned HTTP ${response.status}: ${response.statusText}`,
      response.status
    );
  }

  const json = (await response.json()) as {
    data?: unknown;
    errors?: unknown[];
  };

  if (json.errors && json.errors.length > 0) {
    // Provide friendlier message for indexer unavailability
    const errStr = JSON.stringify(json.errors);
    const isIndexerUnavailable = errStr.includes("bad indexers") || errStr.includes("Unavailable") || errStr.includes("no allocations");
    const message = isIndexerUnavailable
      ? "Subgraph indexers are temporarily unavailable for this chain. Try again in a few minutes."
      : `GraphQL errors: ${errStr}`;
    throw new GraphClientError(
      message,
      undefined,
      json.errors
    );
  }

  // Cache successful results
  setInCache(cacheKey, json.data);

  return json.data;
}
