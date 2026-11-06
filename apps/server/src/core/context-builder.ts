import type {
  CoreContextReport,
  GenerationMessage,
  Message,
  MessageContentPart,
} from "@nexus/shared";
import { CoreExecutionError } from "./errors.js";

export const DEFAULT_CONSERVATIVE_CONTEXT_WINDOW = 4_096;
export const DEFAULT_MAX_CONTEXT_WINDOW_CAP = 65_536;
export const DEFAULT_RESERVED_OUTPUT_BUDGET = 1_024;
export const DEFAULT_MAX_HISTORY_MESSAGES = 40;

const MESSAGE_FRAMING_UNITS = 6;
const CONVERSATION_PRIMER_UNITS = 4;

export interface ContextPolicyOptions {
  readonly fallbackContextWindow?: number;
  readonly maxContextWindowCap?: number;
  readonly defaultReservedOutputBudget?: number;
  readonly maxHistoryMessages?: number;
}

export interface BuildExecutionContextInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly systemInstructions: string;
  readonly persistedHistory: readonly Message[];
  readonly currentInputMessageId: string;
  readonly currentUserContent: string;
  readonly modelContextWindow: number | null;
  readonly requestedMaxOutputTokens?: number;
  readonly policy?: ContextPolicyOptions;
}

export interface BuiltExecutionContext {
  readonly messages: readonly GenerationMessage[];
  readonly report: CoreContextReport;
  readonly includedMessageIds: readonly string[];
}

export function estimateTextUnits(text: string): number {
  const byteLength = Buffer.byteLength(text, "utf8");
  return Math.max(1, Math.ceil(byteLength / 3));
}

export function estimateGenerationMessageUnits(message: GenerationMessage): number {
  return estimateTextUnits(message.content) + MESSAGE_FRAMING_UNITS;
}

export function renderMessagePartsToText(parts: readonly MessageContentPart[]): string {
  const rendered: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const trimmed = part.text.trim();
      if (trimmed.length > 0) {
        rendered.push(part.text);
      }
    } else if (part.type === "reference") {
      const label = "label" in part && part.label ? ` (${part.label})` : "";
      rendered.push(`[Referência ${part.referenceId}${label}]`);
    } else if (part.type === "structured") {
      rendered.push(`[Dados estruturados ${part.format}]`);
    }
  }
  const joined = rendered.join("\n").trim();
  if (!joined) {
    throw new CoreExecutionError(
      "CONTEXT_LIMIT_EXCEEDED",
      "Message content cannot be rendered into non-empty text for provider execution",
      { statusCode: 400 },
    );
  }
  return joined;
}

/**
 * Builds the provider message sequence strictly from persisted conversation messages:
 * - enforces ownerId and conversationId isolation;
 * - respects model contextWindow metadata or applies conservative fallback;
 * - caps history count and total budget (never unbounded);
 * - preserves chronological ordering;
 * - keeps system instructions, user messages, and assistant responses strictly separated;
 * - never silently truncates mandatory messages (system + current input).
 */
export function buildExecutionContext(
  input: BuildExecutionContextInput,
): BuiltExecutionContext {
  const fallbackWindow =
    input.policy?.fallbackContextWindow ?? DEFAULT_CONSERVATIVE_CONTEXT_WINDOW;
  const maxCap = input.policy?.maxContextWindowCap ?? DEFAULT_MAX_CONTEXT_WINDOW_CAP;
  const maxHistoryMessages =
    input.policy?.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const defaultReservedOutput =
    input.policy?.defaultReservedOutputBudget ?? DEFAULT_RESERVED_OUTPUT_BUDGET;

  const hasValidModelWindow =
    typeof input.modelContextWindow === "number" &&
    Number.isInteger(input.modelContextWindow) &&
    input.modelContextWindow > 0;

  const usedFallbackWindow = !hasValidModelWindow;
  const effectiveContextWindow = hasValidModelWindow
    ? Math.min(input.modelContextWindow!, maxCap)
    : Math.min(fallbackWindow, maxCap);

  const rawReservedOutput =
    input.requestedMaxOutputTokens !== undefined
      ? input.requestedMaxOutputTokens
      : Math.min(defaultReservedOutput, Math.floor(effectiveContextWindow * 0.25));

  const reservedOutputBudget = Math.max(0, rawReservedOutput);
  const availableInputBudget = effectiveContextWindow - reservedOutputBudget;

  if (availableInputBudget <= CONVERSATION_PRIMER_UNITS) {
    throw new CoreExecutionError(
      "CONTEXT_LIMIT_EXCEEDED",
      "Requested output token reservation leaves no input context budget for the selected model",
      {
        details: {
          effectiveContextWindow,
          reservedOutputBudget,
        },
      },
    );
  }

  const systemMessage: GenerationMessage = {
    role: "system",
    content: input.systemInstructions,
  };
  const currentUserMessage: GenerationMessage = {
    role: "user",
    content: input.currentUserContent,
  };

  const mandatoryUnits =
    CONVERSATION_PRIMER_UNITS +
    estimateGenerationMessageUnits(systemMessage) +
    estimateGenerationMessageUnits(currentUserMessage);

  if (mandatoryUnits > availableInputBudget) {
    throw new CoreExecutionError(
      "CONTEXT_LIMIT_EXCEEDED",
      "Mandatory system instructions and current input exceed the model input context limit",
      {
        details: {
          effectiveContextWindow,
          usedFallbackWindow,
          availableInputBudget,
          requiredUnits: mandatoryUnits,
        },
      },
    );
  }

  // Strictly isolate persisted messages belonging to the exact owner + conversation,
  // excluding incomplete/failed/cancelled messages and the current input message itself.
  const eligiblePriorMessages: Message[] = [];
  for (const item of input.persistedHistory) {
    if (item.userId !== input.ownerId || item.conversationId !== input.conversationId) {
      throw new CoreExecutionError(
        "PERSISTENCE_FAILED",
        "Cross-owner or cross-conversation message detected during context assembly",
        { retryable: false },
      );
    }
    if (item.id === input.currentInputMessageId) {
      continue;
    }
    if (item.status !== "complete") {
      continue;
    }
    if (item.role !== "user" && item.role !== "assistant") {
      continue;
    }
    eligiblePriorMessages.push(item);
  }

  // Enforce strict chronological order by monotonic sequence, then createdAt.
  eligiblePriorMessages.sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return Date.parse(left.createdAt) - Date.parse(right.createdAt);
  });

  // Select whole messages from newest to oldest within maxHistoryMessages and remaining budget,
  // never mutating or silently truncating individual message content.
  const boundedCandidates = eligiblePriorMessages.slice(-maxHistoryMessages);
  let omittedHistoryCount = eligiblePriorMessages.length - boundedCandidates.length;
  let usedUnits = mandatoryUnits;

  const selectedReverse: Array<{ message: Message; gen: GenerationMessage }> = [];

  for (let idx = boundedCandidates.length - 1; idx >= 0; idx -= 1) {
    const candidate = boundedCandidates[idx]!;
    const text = renderMessagePartsToText(candidate.content);
    const gen: GenerationMessage = {
      role: candidate.role === "assistant" ? "assistant" : "user",
      content: text,
    };
    const candidateUnits = estimateGenerationMessageUnits(gen);
    if (usedUnits + candidateUnits > availableInputBudget) {
      // Stop sliding window here so chronological continuity of recent turns is kept intact
      // without silently corrupting any message content.
      omittedHistoryCount += idx + 1;
      break;
    }
    usedUnits += candidateUnits;
    selectedReverse.push({ message: candidate, gen });
  }

  const chronologicalHistory = selectedReverse.reverse();
  const messages: GenerationMessage[] = [
    systemMessage,
    ...chronologicalHistory.map((entry) => entry.gen),
    currentUserMessage,
  ];

  const includedMessageIds = [
    ...chronologicalHistory.map((entry) => entry.message.id),
    input.currentInputMessageId,
  ];

  return {
    messages,
    includedMessageIds,
    report: {
      effectiveContextWindow,
      usedFallbackWindow,
      reservedOutputBudget,
      availableInputBudget,
      estimatedInputUnits: usedUnits,
      includedHistoryCount: chronologicalHistory.length,
      omittedHistoryCount,
    },
  };
}
