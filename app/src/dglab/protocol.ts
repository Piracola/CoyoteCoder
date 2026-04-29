import type { Channel } from "../config/schema.js";

export type DglabChannelIndex = 1 | 2;

export interface DglabEnvelope {
  type: string | number;
  clientId: string;
  targetId: string;
  message: string;
  channel?: DglabChannelIndex | Channel;
  strength?: number;
  time?: number;
}

export function channelToIndex(channel: Channel): DglabChannelIndex {
  return channel === "A" ? 1 : 2;
}

export function clampStrength(strength: number): number {
  return Math.min(200, Math.max(0, Math.round(strength)));
}

export function buildQrLink(socketUrl: string, clientId: string): string {
  const base = socketUrl.replace(/\/+$/, "");
  return `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${base}/${clientId}`;
}

export function buildSetStrengthMessage(
  clientId: string,
  targetId: string,
  channel: Channel,
  strength: number
): DglabEnvelope {
  return {
    type: 3,
    clientId,
    targetId,
    channel: channelToIndex(channel),
    strength: clampStrength(strength),
    message: "set channel"
  };
}

export function buildClearMessage(clientId: string, targetId: string, channel: Channel): DglabEnvelope {
  return {
    type: 4,
    clientId,
    targetId,
    message: `clear-${channelToIndex(channel)}`
  };
}

export function buildPulseMessage(
  clientId: string,
  targetId: string,
  channel: Channel,
  waves: string[],
  durationSeconds: number
): DglabEnvelope {
  return {
    type: "clientMsg",
    clientId,
    targetId,
    channel,
    time: Math.max(1, Math.ceil(durationSeconds)),
    message: `${channel}:${JSON.stringify(waves)}`
  };
}
