export type CoyoteEventType =
  | "request.started"
  | "request.body_seen"
  | "response.started"
  | "response.chunk"
  | "response.done"
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
  | ResponseErrorEvent
  | ResponseAbortedEvent;
