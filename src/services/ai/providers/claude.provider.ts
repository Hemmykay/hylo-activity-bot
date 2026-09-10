import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/config/index.js';
import { AIProviderError } from '@/lib/errors.js';
import { createLogger } from '@/lib/logger.js';
import type { AIProvider, AIRequest, AIResponse } from '../ai.types.js';

const logger = createLogger('claude-provider');

// Anthropic error codes worth retrying on the next provider in the chain.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

// 400 sub-messages that indicate billing/quota, not a bad request.
// These should fall back to the next provider rather than surfacing to the user.
const BILLING_MESSAGES = ['credit balance', 'quota', 'billing', 'insufficient_quota'];

export class ClaudeProvider implements AIProvider {
  readonly name = 'claude';
  readonly model: string;
  private client: Anthropic;

  constructor() {
    if (!config.ai.anthropicApiKey) {
      throw new AIProviderError('claude', 'ANTHROPIC_API_KEY is not set');
    }
    this.client = new Anthropic({ apiKey: config.ai.anthropicApiKey });
    this.model = config.ai.claudeModel;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    // Anthropic SDK uses 'user'/'assistant' roles; system goes as a top-level param
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Merge any system-role messages with the explicit systemPrompt
    const systemParts: string[] = [];
    if (request.systemPrompt) systemParts.push(request.systemPrompt);
    request.messages
      .filter((m) => m.role === 'system')
      .forEach((m) => systemParts.push(m.content));
    const system = systemParts.join('\n\n') || undefined;

    try {
      logger.debug({ model: this.model, messageCount: messages.length }, 'Claude request');

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages,
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      });

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('');

      logger.debug(
        { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        'Claude response received',
      );

      return {
        text,
        provider: this.name,
        model: this.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        usedFallback: false,
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        logger.warn(
          { status: err.status, message: err.message },
          'Claude API error',
        );

        throw new AIProviderError(
          'claude',
          `${err.status} ${err.message}`,
          err,
        );
      }
      throw new AIProviderError('claude', 'Unexpected error', err);
    }
  }

  /** Returns true for errors worth trying the next provider for. */
  static isRetryable(err: unknown): boolean {
    if (err instanceof Anthropic.APIError) {
      if (RETRYABLE_STATUS_CODES.has(err.status)) return true;
      // Billing/quota 400s should fall back — the provider has no credits,
      // but a different provider might work fine.
      if (err.status === 400) {
        const msg = err.message.toLowerCase();
        return BILLING_MESSAGES.some((phrase) => msg.includes(phrase));
      }
      return false;
    }
    return true; // network errors, timeouts — always retry
  }
}
