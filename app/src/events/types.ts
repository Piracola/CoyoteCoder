export type CoyoteEventType =
  | "request.started"
  | "request.body_seen"
  | "response.started"
  | "response.chunk"
  | "response.done"
  | "response.tool_call"
  | "response.error_status"
  | "response.error"
  | "response.aborted"
  | "dglab.connected"
  | "dglab.bound"
  | "dglab.disconnected"
  | "dglab.feedback"
  | "dglab.strength_report"
  | "dglab.test"
  | "safety.armed"
  | "safety.disarmed"
  | "safety.panic";

export interface BaseEvent {
  type: CoyoteEventType;
  requestId?: string;
  timestamp: number;
  model?: string;
}

export type SimpleEvent = BaseEvent & {
  type:
    | "request.started"
    | "response.started"
    | "dglab.connected"
    | "dglab.bound"
    | "dglab.disconnected"
    | "dglab.feedback"
    | "dglab.strength_report"
    | "dglab.test"
    | "safety.armed"
    | "safety.disarmed"
    | "safety.panic";
};

export interface RequestBodySeenEvent extends BaseEvent {
  type: "request.body_seen";
  bytes: number;
  stream: boolean;
  endpoint: string;
  /** Only populated when privacy.store_raw_content is explicitly enabled. */
  rawBody?: string;
}

export interface ResponseChunkEvent extends BaseEvent {
  type: "response.chunk";
  bytes: number;
  chars: number;
  deltaMs: number;
  cumulativeChars: number;
  streamRateCharsPerSec: number;
}

export interface ResponseDoneEvent extends BaseEvent {
  type: "response.done";
  statusCode?: number;
  bytes?: number;
  chars?: number;
  durationMs?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedTokens?: boolean;
  finishReason?: string;
  /** Only populated when privacy.store_raw_content is explicitly enabled. */
  rawResponse?: string;
}

export interface ResponseToolCallEvent extends BaseEvent {
  type: "response.tool_call";
  toolCallCount: number;
  toolNames?: string[];
}

export interface ResponseErrorStatusEvent extends BaseEvent {
  type: "response.error_status";
  statusCode: number;
  bytes?: number;
  chars?: number;
  message?: string;
  durationMs?: number;
}

export interface ResponseErrorEvent extends BaseEvent {
  type: "response.error";
  message: string;
}

export interface ResponseAbortedEvent extends BaseEvent {
  type: "response.aborted";
  message: string;
}

export type CoyoteEvent =
  | SimpleEvent
  | RequestBodySeenEvent
  | ResponseChunkEvent
  | ResponseDoneEvent
  | ResponseToolCallEvent
  | ResponseErrorStatusEvent
  | ResponseErrorEvent
  | ResponseAbortedEvent;
