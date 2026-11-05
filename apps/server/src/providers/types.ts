export type ProviderCostClass = "free_confirmed" | "paid" | "unknown";
export interface ProviderModelInfo { readonly id: string; readonly key: string; readonly displayName: string; readonly free: boolean; }
export interface ChatMessage { readonly role: "system" | "user" | "assistant"; readonly content: string; }
export interface ChatCompletionRequest { readonly model: string; readonly messages: readonly ChatMessage[]; readonly temperature?: number; readonly maxTokens?: number; readonly signal?: AbortSignal; }
export interface ChatCompletionResult { readonly id: string; readonly model: string; readonly content: string; readonly finishReason: "stop" | "length" | "content_filter" | "error" | "unknown"; }
export interface ProviderAdapter {
  readonly id: string; readonly key: string; readonly displayName: string; readonly costClass: ProviderCostClass;
  listModels(): Promise<readonly ProviderModelInfo[]>; isConfigured(): boolean;
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}
export class ProviderError extends Error {
  readonly code: "NOT_CONFIGURED" | "PAID_BLOCKED" | "RATE_LIMIT" | "UPSTREAM" | "CANCELLED";
  readonly retryable: boolean; readonly providerKey: string;
  constructor(code: ProviderError["code"], message: string, options: { providerKey: string; retryable?: boolean; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError"; this.code = code; this.providerKey = options.providerKey; this.retryable = options.retryable ?? false;
  }
}
