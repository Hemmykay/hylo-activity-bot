import { z } from 'zod';

export const PROVIDER_NAMES = ['claude', 'gemini', 'openrouter', 'ollama'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const envSchema = z.object({
  // ─── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),

  // ─── Discord ───────────────────────────────────────────────────────────────
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, 'ALLOWED_USER_IDS must contain at least one Discord user ID')
    .transform((val) => val.split(',').map((id) => id.trim()).filter(Boolean)),
  // Discord role ID required (alongside ALLOWED_USER_IDS) to use the bot.
  REQUIRED_ROLE_ID: z.string().min(1, 'REQUIRED_ROLE_ID is required'),

  // ─── AI Provider Chain ─────────────────────────────────────────────────────
  // Ordered comma-separated list. Tried left-to-right until one succeeds.
  // Providers without a corresponding API key are silently skipped at startup.
  AI_PROVIDER_CHAIN: z.string().default('claude'),

  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  // Ollama needs no API key — just a base URL pointing to your local instance
  OLLAMA_BASE_URL: z.string().optional(),

  CLAUDE_MODEL: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OLLAMA_MODEL: z.string().optional(),

  // ─── Helius (Solana on-chain data) ─────────────────────────────────────────
  // Optional — on-chain queries are silently disabled when this is not set.
  HELIUS_API_KEY: z.string().optional(),
  // Optional second key — same provider, used as an automatic failover
  // endpoint (see rpc() in helius.service.ts) if the first is rate-limited or down.
  HELIUS_API_KEY_2: z.string().optional(),

  // ─── Hylo Public API v1 (https://api.hylo.so/docs) ──────────────────────────
  // Primary source for the mint-watcher event stream and asset pricing, with
  // Helius RPC wired in behind it as the automatic fallback. Set
  // HYLO_V1_EVENTS_DISABLED=1 to force the bot back onto pure RPC event
  // scanning (kill switch — the API client itself needs no configuration).
  HYLO_API_BASE_URL: z.string().optional(),
  HYLO_V1_EVENTS_DISABLED: z.string().optional(),

  // ─── Mint Watcher ───────────────────────────────────────────────────────────
  // Optional — the background mint-alert watcher is disabled until this is set.
  MINT_ALERTS_CHANNEL_ID: z.string().optional(),
  // Minimum USD value a mint/stake must reach to actually post an alert.
  // Default 0 — report everything. Events with no resolvable price always
  // post regardless, since there's nothing to compare against the threshold.
  MIN_VAL_REPORT: z.coerce.number().min(0).default(0),
  // Optional — the eHYUSD cap-progress milestone poster is disabled until this is set.
  EHYUSD_CAP_CHANNEL_ID: z.string().optional(),

  // ─── Price-Ticker Bots ──────────────────────────────────────────────────────
  // Each is its own separate Discord bot application/token (a Discord member-list
  // display convention — one bot per row, its live price as a custom status).
  // Any not set are simply skipped — that ticker doesn't run.
  TICKER_BOT_TOKEN_XSOL: z.string().optional(),
  TICKER_BOT_TOKEN_XBTC: z.string().optional(),
  TICKER_BOT_TOKEN_XHYPE: z.string().optional(),
  TICKER_BOT_TOKEN_EHYUSD: z.string().optional(),

  // ─── X (Twitter) ────────────────────────────────────────────────────────────
  // Optional — posting is disabled until all four credentials are set.
  // Only the daily mint/burn summary posts here (not live mint/stake/offload
  // alerts) — X's write-API rate limits don't tolerate the alert volume.
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_TOKEN_SECRET: z.string().optional(),
  // Minimum |net USD| the daily summary must reach to also post to X. Default
  // 0 — post every day. Days where net value can't be resolved never post to
  // X regardless (see postDailySummary), since there's nothing to compare.
  TWITTER_MIN_NET_USD: z.coerce.number().min(0).default(0),

  // ─── Dev alerts ──────────────────────────────────────────────────────────
  // Discord user ID that receives dev-attention DMs (handshake/network
  // faults, shard disconnects, RPC exhaustion, ticker login failures).
  DEV_ALERT_USER_ID: z.string().optional(),

  // ─── Application ───────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  FAQ_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  PENDING_ACTION_TTL_MINUTES: z.coerce.number().int().positive().default(30),
});

// Keys required per provider. Ollama has no key requirement.
const PROVIDER_KEY_MAP: Partial<Record<ProviderName, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GOOGLE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function parseProviderChain(
  raw: string,
  env: { ANTHROPIC_API_KEY?: string | undefined; GOOGLE_AI_API_KEY?: string | undefined; OPENROUTER_API_KEY?: string | undefined },
): { active: ProviderName[]; skipped: string[] } {
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (names.length === 0) {
    throw new Error('AI_PROVIDER_CHAIN must contain at least one provider');
  }

  const invalid = names.filter((n) => !(PROVIDER_NAMES as readonly string[]).includes(n));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown provider(s) in AI_PROVIDER_CHAIN: ${invalid.join(', ')}. ` +
        `Valid values: ${PROVIDER_NAMES.join(', ')}`,
    );
  }

  const unique = [...new Set(names)] as ProviderName[];

  const active: ProviderName[] = [];
  const skipped: string[] = [];

  for (const provider of unique) {
    const keyName = PROVIDER_KEY_MAP[provider];
    if (keyName && !env[keyName as keyof typeof env]) {
      skipped.push(`${provider} (${keyName} not set)`);
    } else {
      active.push(provider);
    }
  }

  // No provider having a key is NOT a fatal startup error: on-chain features
  // (mint/stake/offload alerts, asset/price queries) never touch the AI chain,
  // so the bot must still come up and serve those. AI-dependent commands will
  // fail per-request instead — see AIService.generate().
  if (active.length === 0 && skipped.length > 0) {
    console.warn(
      `[config] No AI providers have usable API keys. Skipped: ${skipped.join(', ')}. ` +
        `AI-dependent features will be unavailable until a key is configured.`,
    );
  }

  return { active, skipped };
}

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = result.data;
  const { active: providerChain, skipped } = parseProviderChain(env.AI_PROVIDER_CHAIN, env);

  // Log skipped providers at startup (can't use logger here, config loads first)
  if (skipped.length > 0) {
    console.warn(`[config] Skipping providers without API keys: ${skipped.join(', ')}`);
  }

  return {
    database: {
      url: env.DATABASE_URL,
    },
    discord: {
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      allowedUserIds: env.ALLOWED_USER_IDS,
      requiredRoleId: env.REQUIRED_ROLE_ID,
    },
    ai: {
      providerChain,
      skippedProviders: skipped,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      googleApiKey: env.GOOGLE_AI_API_KEY,
      openrouterApiKey: env.OPENROUTER_API_KEY,
      ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      claudeModel: env.CLAUDE_MODEL || 'claude-opus-4-8',
      geminiModel: env.GEMINI_MODEL || 'gemini-2.0-flash-exp',
      openrouterModel: env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      ollamaModel: env.OLLAMA_MODEL || 'gemma3:4b',
    },
    helius: {
      apiKey: env.HELIUS_API_KEY ?? '',
      // Ordered failover list — rpc() in helius.service.ts tries these in order,
      // moving to the next only once the current one's own retries are exhausted.
      rpcUrls: [
        ...[env.HELIUS_API_KEY, env.HELIUS_API_KEY_2]
          .filter((key): key is string => Boolean(key))
          .map((key) => `https://mainnet.helius-rpc.com/?api-key=${key}`),
        'https://api.mainnet-beta.solana.com',
      ],
      enabled: Boolean(env.HELIUS_API_KEY),
    },
    hyloApi: {
      baseUrl: env.HYLO_API_BASE_URL || 'https://api.hylo.so',
      eventsDisabled: Boolean(env.HYLO_V1_EVENTS_DISABLED),
    },
    mintAlerts: {
      channelId: env.MINT_ALERTS_CHANNEL_ID || null,
      minValueUsd: env.MIN_VAL_REPORT,
    },
    ehyusdCap: {
      channelId: env.EHYUSD_CAP_CHANNEL_ID || null,
    },
    // Symbol -> bot token, omitting any asset whose token isn't configured.
    priceTickers: (
      [
        { symbol: 'XSOL', token: env.TICKER_BOT_TOKEN_XSOL },
        { symbol: 'XBTC', token: env.TICKER_BOT_TOKEN_XBTC },
        { symbol: 'XHYPE', token: env.TICKER_BOT_TOKEN_XHYPE },
        { symbol: 'EHYUSD', token: env.TICKER_BOT_TOKEN_EHYUSD },
      ] as Array<{ symbol: string; token: string | undefined }>
    ).filter((t): t is { symbol: string; token: string } => Boolean(t.token)),
    twitter: {
      enabled: Boolean(
        env.TWITTER_API_KEY && env.TWITTER_API_SECRET && env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_TOKEN_SECRET,
      ),
      apiKey: env.TWITTER_API_KEY ?? '',
      apiSecret: env.TWITTER_API_SECRET ?? '',
      accessToken: env.TWITTER_ACCESS_TOKEN ?? '',
      accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET ?? '',
      minNetUsd: env.TWITTER_MIN_NET_USD,
    },
    devAlert: {
      userId: env.DEV_ALERT_USER_ID || '517751601658724362',
    },
    app: {
      nodeEnv: env.NODE_ENV,
      logLevel: env.LOG_LEVEL,
      faqConfidenceThreshold: env.FAQ_CONFIDENCE_THRESHOLD,
      pendingActionTtlMinutes: env.PENDING_ACTION_TTL_MINUTES,
      isDevelopment: env.NODE_ENV === 'development',
      isProduction: env.NODE_ENV === 'production',
    },
  } as const;
}

export const config = loadConfig();
export type Config = typeof config;
