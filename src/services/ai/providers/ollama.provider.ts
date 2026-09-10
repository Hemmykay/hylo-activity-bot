import OpenAI from 'openai';
import { config } from '@/config/index.js';
import { AIProviderError } from '@/lib/errors.js';
import { createLogger } from '@/lib/logger.js';
import type { AIProvider, AIRequest, AIResponse } from '../ai.types.js';

const logger = createLogger('ollama-provider');

/**
 * Ollama runs open-source models (Gemma, Llama, Mistral, Phi, etc.) locally.
 * It exposes an OpenAI-compatible API, so we reuse the OpenAI SDK.
 *
 * Install Ollama: https://ollama.ai
 * Pull a model:  ollama pull gemma3:4b
 * Start server:  ollama serve   (auto-starts on macOS/Linux after install)
 *
 * Set OLLAMA_MODEL in .env to switch models, e.g.:
 *   OLLAMA_MODEL=gemma3:4b       (Google Gemma 3 — 4B params, fast)
 *   OLLAMA_MODEL=gemma3:27b      (more capable, needs ~20GB RAM)
 *   OLLAMA_MODEL=llama3.2:3b     (Meta Llama 3.2 — very fast)
 *   OLLAMA_MODEL=phi4:latest     (Microsoft Phi-4)
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  readonly model: string;
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      baseURL: config.ai.ollamaBaseUrl,
      apiKey: 'ollama', // Ollama ignores the key but the SDK requires a non-empty value
    });
    this.model = config.ai.ollamaModel;
    logger.debug({ baseURL: config.ai.ollamaBaseUrl, model: this.model }, 'Ollama provider ready');
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

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
      logger.debug({ model: this.model, messageCount: messages.length }, 'Ollama request');

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // Ollama ignores max_tokens but set it anyway for compatibility
        max_tokens: request.maxTokens ?? 1024,
      });

      const choice = response.choices[0];
      if (!choice) throw new AIProviderError('ollama', 'No completion returned');

      const text = choice.message.content ?? '';

      logger.debug(
        { inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens },
        'Ollama response received',
      );

      return {
        text,
        provider: this.name,
        model: this.model,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        usedFallback: false,
      };
    } catch (err) {
      if (err instanceof AIProviderError) throw err;

      if (err instanceof OpenAI.APIError) {
        // Ollama connection refused means the server isn't running
        if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
          throw new AIProviderError(
            'ollama',
            `Cannot connect to Ollama at ${config.ai.ollamaBaseUrl}. Is Ollama running? Try: ollama serve`,
            err,
          );
        }
        throw new AIProviderError('ollama', `${err.status} ${err.message}`, err);
      }

      // Node fetch errors when Ollama isn't running
      if (err instanceof Error && (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed'))) {
        throw new AIProviderError(
          'ollama',
          `Cannot connect to Ollama at ${config.ai.ollamaBaseUrl}. Is Ollama running? Try: ollama serve`,
          err,
        );
      }

      throw new AIProviderError('ollama', err instanceof Error ? err.message : 'Unexpected error', err);
    }
  }
}
