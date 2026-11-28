import type { ChatOutputField } from '@concordia/protocol/chat-output';

export type Protocol = 'chat-completions' | 'responses' | 'gemini' | 'anthropic';
export interface ProviderConfig {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  credentialRef?: string;
  endpoint?: string;
  stream?: boolean;
  timeoutMs?: number;
  maxOutputTokens?: number;
  outputTokenField?: ChatOutputField;
  headers?: Record<string, string>;
  headerRefs?: Record<string, string>;
  params?: Record<string, unknown>;
}
export type ResponseReasoning = { type: 'reasoning'; encrypted_content: string; summary: [] };
export interface ModelAction {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  generatedId?: boolean;
  responseReasoning?: ResponseReasoning[];
}
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ModelAction[];
}
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'cancelled'
  | 'transport'
  | 'invalid'
  | 'budget';
export type ModelFailure = { type: 'error'; kind: ErrorKind; message: string; httpStatus?: number };
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | ({ type: 'action' } & ModelAction)
  | ({ type: 'usage' } & ModelUsage)
  | { type: 'completed' }
  | ModelFailure;
export interface StreamOptions {
  /** Identity used to retain native continuation data in this provider and this conversation only. */
  assistantReply?: ModelMessage;
  /** Called after local validation and credential lookup, immediately before network dispatch. */
  onDispatch?: (reservationId?: string) => void;
  maxContextBytes?: number;
  stream?: boolean;
  signal?: AbortSignal;
}
export interface ModelProvider {
  stream(messages: ModelMessage[], tools?: ModelTool[], options?: StreamOptions): AsyncIterable<ModelEvent>;
  validateConnection(
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<({ ok: true; text: string } | { ok: false; error: ModelFailure }) & { httpStatus?: number; usage?: ModelUsage }>;
  getCapabilities(): { nativeTools: boolean; streaming: boolean; dispatchSignal?: true };
}
export type CredentialReader = (ref: string, signal?: AbortSignal) => Promise<string>;
