import type { AppConfig, Channel } from "../config/schema.js";
import type { ShockPlan } from "./types.js";

export interface SafetyStatus {
  dryRun: boolean;
  armed: boolean;
  panic: boolean;
  channelLimits: Record<Channel, number>;
  minEventIntervalMs: number;
  maxContinuousOutputMs: number;
  maxEventsPerMinute: number;
  recentEventsInWindow: number;
}

export interface SafetySettingsPatch {
  channelLimits?: Partial<Record<Channel, number>>;
  minEventIntervalMs?: number;
  maxContinuousOutputMs?: number;
  maxEventsPerMinute?: number;
}

export class SafetyGate {
  private dryRun: boolean;
  private armed: boolean;
  private panicState = false;
  private readonly eventTimes: number[] = [];
  private readonly lastByChannel = new Map<Channel, number>();

  constructor(private readonly config: AppConfig["safety"]) {
    this.dryRun = config.dry_run;
    this.armed = config.armed;
  }

  arm(): void {
    this.armed = true;
    this.panicState = false;
  }

  disarm(): void {
    this.armed = false;
  }

  panic(): ShockPlan[] {
    this.panicState = true;
    this.armed = false;
    return [
      { kind: "shock.zero", channel: "A", intensity: 0, durationMs: 0, reason: "panic" },
      { kind: "shock.zero", channel: "B", intensity: 0, durationMs: 0, reason: "panic" }
    ];
  }

  setDryRun(value: boolean): void {
    this.dryRun = value;
  }

  updateSettings(patch: SafetySettingsPatch): void {
    if (patch.channelLimits?.A !== undefined) {
      this.config.channel_limits.A = clampInteger(patch.channelLimits.A, 0, 100);
    }
    if (patch.channelLimits?.B !== undefined) {
      this.config.channel_limits.B = clampInteger(patch.channelLimits.B, 0, 100);
    }
    if (patch.minEventIntervalMs !== undefined) {
      this.config.min_event_interval_ms = clampInteger(patch.minEventIntervalMs, 0, 10_000);
    }
    if (patch.maxContinuousOutputMs !== undefined) {
      this.config.max_continuous_output_ms = clampInteger(patch.maxContinuousOutputMs, 1, 30_000);
    }
    if (patch.maxEventsPerMinute !== undefined) {
      this.config.max_events_per_minute = clampInteger(patch.maxEventsPerMinute, 1, 600);
    }
  }

  getStatus(): SafetyStatus {
    this.prune(Date.now());
    return {
      dryRun: this.dryRun,
      armed: this.armed,
      panic: this.panicState,
      channelLimits: this.config.channel_limits,
      minEventIntervalMs: this.config.min_event_interval_ms,
      maxContinuousOutputMs: this.config.max_continuous_output_ms,
      maxEventsPerMinute: this.config.max_events_per_minute,
      recentEventsInWindow: this.eventTimes.length
    };
  }

  evaluate(plan: ShockPlan, now = Date.now()): ShockPlan | undefined {
    if (plan.kind === "shock.zero" || plan.kind === "shock.clear") {
      return plan;
    }

    if (this.panicState) {
      return undefined;
    }

    if (!this.dryRun && !this.armed) {
      return undefined;
    }

    if (!plan.channel) {
      return undefined;
    }

    this.prune(now);
    if (this.eventTimes.length >= this.config.max_events_per_minute) {
      return undefined;
    }

    const last = this.lastByChannel.get(plan.channel) ?? 0;
    if (now - last < this.config.min_event_interval_ms) {
      return undefined;
    }

    const channelLimit = this.config.channel_limits[plan.channel] / 100;
    const safeIntensity = Math.min(plan.intensity, channelLimit);
    const safeDuration = Math.min(plan.durationMs, this.config.max_continuous_output_ms);

    this.eventTimes.push(now);
    this.lastByChannel.set(plan.channel, now);

    return {
      ...plan,
      intensity: safeIntensity,
      durationMs: safeDuration
    };
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.eventTimes.length > 0 && this.eventTimes[0] < cutoff) {
      this.eventTimes.shift();
    }
  }
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
