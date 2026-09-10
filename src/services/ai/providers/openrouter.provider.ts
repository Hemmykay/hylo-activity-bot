import OpenAI from 'openai';
import { config } from '@/config/index.js';
import { AIProviderError } from '@/lib/errors.js';
import { createLogger } from '@/lib/logger.js';
import type { AIProvider, AIRequest, AIResponse } from '../ai.types.js';

const logger = createLogger('openrouter-provider');

// HTTP status codes worth retrying on the next provider in the chain
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

export class OpenRouterProvider implements AIProvider {
  readonly name = 'openrouter';
  readonly model: string;
  private client: OpenAI;

  constructor() {
    if (!config.ai.openrouterApiKey) {
      throw new AIProviderError('openrouter', 'OPENROUTER_API_KEY is not set');
    }

    this.client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.ai.openrouterApiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://hylo.com',
        'X-Title': 'Hylo Support Copilot',
      },
    });

    this.model = config.ai.openrouterModel;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // Merge systemPrompt + any system-role messages into a single system turn
    const systemParts: string[] = [];
    if (request.systemPrompt) systemParts.push(request.systemPrompt);
    request.messages
      .filter((m) => m.role === 'system')
      .forEach((m) => systemParts.push(m.content));

    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }

    for (const msg of request.messages.filter((m) => m.role !== 'system')) {
      messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
    }

    try {
      logger.debug({ model: this.model, messageCount: messages.length }, 'OpenRouter request');

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: request.maxTokens ?? 1024,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new AIProviderError('openrouter', 'No completion returned');
      }

      const text = choice.message.content ?? '';

      logger.debug(
        {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          model: response.model,
        },
        'OpenRouter response received',
      );

      return {
        text,
        provider: this.name,
        model: response.model ?? this.model,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        usedFallback: false,
      };
    } catch (err) {
      if (err instanceof AIProviderError) throw err;

      if (err instanceof OpenAI.APIError) {
        logger.warn({ status: err.status, message: err.message }, 'OpenRouter API error');
        throw new AIProviderError('openrouter', `${err.status} ${err.message}`, err);
      }

      throw new AIProviderError('openrouter', 'Unexpected error', err);
    }
  }

  static isRetryable(err: unknown): boolean {
    if (err instanceof OpenAI.APIError) {
      return RETRYABLE_STATUS_CODES.has(err.status);
    }
    return true;
  }
}
