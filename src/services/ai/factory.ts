import type { ProviderName } from '@/config/index.js';
import type { AIProvider } from './ai.types.js';
import { ClaudeProvider } from './providers/claude.provider.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { OpenRouterProvider } from './providers/openrouter.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';

export function createProvider(name: ProviderName): AIProvider {
  switch (name) {
    case 'claude':
      return new ClaudeProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'openrouter':
      return new OpenRouterProvider();
    case 'ollama':
      return new OllamaProvider();
  }
}
