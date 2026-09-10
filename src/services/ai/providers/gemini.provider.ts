import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import { config } from '@/config/index.js';
import { AIProviderError } from '@/lib/errors.js';
import { createLogger } from '@/lib/logger.js';
import type { AIProvider, AIRequest, AIResponse } from '../ai.types.js';

const logger = createLogger('gemini-provider');

// Safety settings that match our internal support use case.
// We don't want the model refusing to discuss DeFi collateral liquidations etc.
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;
  private client: GoogleGenerativeAI;

  constructor() {
    if (!config.ai.googleApiKey) {
      throw new AIProviderError('gemini', 'GOOGLE_AI_API_KEY is not set');
    }
    this.client = new GoogleGenerativeAI(config.ai.googleApiKey);
    this.model = config.ai.geminiModel;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    try {
      const genModel = this.client.getGenerativeModel({
        model: this.model,
        safetySettings: SAFETY_SETTINGS,
        generationConfig: {
          temperature: request.temperature ?? 0.7,
          maxOutputTokens: request.maxTokens ?? 1024,
        },
        ...(request.systemPrompt ? { systemInstruction: request.systemPrompt } : {}),
      });

      // Gemini uses a flat history array + current message
      // System-role messages are folded into systemInstruction above
      const history = request.messages
        .filter((m) => m.role !== 'system')
        .slice(0, -1) // everything except the last message
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const lastMessage = request.messages.filter((m) => m.role !== 'system').at(-1);
      if (!lastMessage) {
        throw new AIProviderError('gemini', 'No user message provided');
      }

      logger.debug({ model: this.model, historyLength: history.length }, 'Gemini request');

      const chat = genModel.startChat({ history });
      const result = await chat.sendMessage(lastMessage.content);
      const response = result.response;

      // Check for safety blocks
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY') {
        throw new AIProviderError('gemini', 'Response blocked by safety filters');
      }

      const text = response.text();
      const usage = response.usageMetadata;

      logger.debug(
        {
          inputTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount,
        },
        'Gemini response received',
      );

      return {
        text,
        provider: this.name,
        model: this.model,
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        usedFallback: false,
      };
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      throw new AIProviderError('gemini', err instanceof Error ? err.message : 'Unexpected error', err);
    }
  }
}
