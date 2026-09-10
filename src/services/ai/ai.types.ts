export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIRequest {
  messages: AIMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AIResponse {
  text: string;
  provider: string;
  model: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  usedFallback: boolean;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generate(request: AIRequest): Promise<AIResponse>;
}
