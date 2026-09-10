import { config } from '@/config/index.js';
import { AIProviderError } from '@/lib/errors.js';
import { createLogger } from '@/lib/logger.js';
import { createProvider } from './factory.js';
import { ClaudeProvider } from './providers/claude.provider.js';
import { OpenRouterProvider } from './providers/openrouter.provider.js';
import type { AIProvider, AIRequest, AIResponse } from './ai.types.js';

const logger = createLogger('ai-service');

class AIService {
  private chain: AIProvider[];

  constructor() {
    this.chain = [];

    for (const name of config.ai.providerChain) {
      try {
        this.chain.push(createProvider(name));
      } catch (err) {
        // Provider failed to initialise (e.g. missing key) — skip it
        logger.warn(
          { provider: name, reason: err instanceof Error ? err.message : String(err) },
          'Provider skipped — failed to initialise',
        );
      }
    }

    const skipped = config.ai.skippedProviders;

    if (this.chain.length === 0) {
      // No AI providers available — do NOT crash the process. On-chain
      // features (mint/stake/offload alerts, asset/price lookups) never call
      // aiService and must keep working regardless. AI-dependent commands
      // will fail gracefully per-request via the check in generate() below.
      logger.warn(
        { skipped },
        'No AI providers available — AI-dependent features disabled, on-chain features unaffected',
      );
      return;
    }

    logger.info(
      {
        chain: this.chain.map((p) => `${p.name}(${p.model})`).join(' → '),
        ...(skipped.length > 0 ? { skipped } : {}),
      },
      'AI service initialised',
    );
  }

  get isAvailable(): boolean {
    return this.chain.length > 0;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    if (this.chain.length === 0) {
      throw new AIProviderError(
        'none',
        'No AI providers are configured or available right now. AI-powered features (rewrites, FAQ chat, customer-question answers) are temporarily unavailable — on-chain features like mint/stake/offload alerts and asset/price lookups are unaffected.',
      );
    }

    let lastError: unknown;

    for (const [index, provider] of this.chain.entries()) {
      try {
        const response = await provider.generate(request);
        // Mark as fallback if any provider before this one was tried
        return { ...response, usedFallback: index > 0 };
      } catch (err) {
        lastError = err;

        if (!this.shouldTryNext(provider, err)) {
          // Hard failure — no point trying the remaining providers
          throw err;
        }

        const next = this.chain[index + 1];
        if (next) {
          logger.warn(
            {
              failed: provider.name,
              next: next.name,
              reason: err instanceof Error ? err.message : String(err),
            },
            'Provider failed — trying next in chain',
          );
        }
      }
    }

    // All providers exhausted
    const tried = this.chain.map((p) => p.name).join(', ');
    throw new AIProviderError(
      tried,
      `All providers failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  }

  get activeProviderName(): string {
    return this.chain[0]?.name ?? 'none';
  }

  get chainDescription(): string {
    return this.chain.map((p) => p.name).join(' → ');
  }

  /**
   * Decides whether to try the next provider after `err` from `provider`.
   * We skip remaining providers only for hard errors that would fail everywhere:
   * auth failures and content safety blocks.
   */
  private shouldTryNext(provider: AIProvider, err: unknown): boolean {
    if (!(err instanceof AIProviderError)) return true;

    // Auth errors — wrong key, no point trying another route on the same service
    if (err.message.includes('401') || err.message.includes('403')) {
      logger.error({ provider: provider.name }, 'Authentication failure — check API key');
      return false;
    }

    // Safety blocks are content-specific; a different provider won't unblock them
    if (err.message.includes('safety filters')) return false;

    // Use provider-specific retryability checks where available
    if (provider instanceof ClaudeProvider) {
      return ClaudeProvider.isRetryable((err as { cause?: unknown }).cause);
    }
    if (provider instanceof OpenRouterProvider) {
      return OpenRouterProvider.isRetryable((err as { cause?: unknown }).cause);
    }

    return true;
  }
}

// Singleton — one instance shared across the whole application
export const aiService = new AIService();
