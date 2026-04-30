import type { Channel } from "../config/schema.js";
import type { ShockSink, ShockPlan } from "../shock/types.js";
import type { DglabController } from "./controller.js";
import { prepareWaveForPlan, resolveWaveform, WaveformRegistry } from "./waves.js";

export class DglabSink implements ShockSink {
  private readonly lastContinuousPulseAt: Partial<Record<Channel, number>> = {};

  constructor(
    private readonly controller: DglabController,
    private readonly waveforms = new WaveformRegistry()
  ) {}

  async send(plan: ShockPlan, meta: { dryRun: boolean; armed: boolean }): Promise<void> {
    if (meta.dryRun || !meta.armed) {
      console.log(JSON.stringify({ ...plan, mode: meta.dryRun ? "dry-run" : "blocked-unarmed", armed: meta.armed }));
      return;
    }

    if (plan.kind === "shock.zero") {
      this.lastContinuousPulseAt.A = undefined;
      this.lastContinuousPulseAt.B = undefined;
      await this.controller.zeroAll();
      return;
    }

    if (!plan.channel) {
      return;
    }

    if (plan.kind === "shock.clear") {
      this.lastContinuousPulseAt[plan.channel] = undefined;
      await this.controller.clear(plan.channel);
      return;
    }

    const strength = Math.round(plan.intensity * 100);
    const catalog = await this.waveforms.getCatalog();
    const waveform = resolveWaveform(catalog, plan.waveId, plan.reason);
    const waves = prepareWaveForPlan(waveform.waves, plan.continuous, plan.durationMs);

    if (plan.continuous) {
      await this.controller.setStrength(plan.channel, strength);
      if (this.shouldRefreshContinuousPulse(plan.channel, plan.durationMs)) {
        await this.controller.pulse(plan.channel, waves, plan.durationMs);
      }
      return;
    }

    this.lastContinuousPulseAt[plan.channel] = undefined;
    await this.controller.clear(plan.channel);
    await this.controller.setStrength(plan.channel, strength);
    await this.controller.pulse(plan.channel, waves, plan.durationMs);
  }

  private shouldRefreshContinuousPulse(channel: Channel, durationMs: number): boolean {
    const now = Date.now();
    const refreshMs = Math.max(700, Math.min(1500, Math.round(durationMs * 0.7)));
    const lastSentAt = this.lastContinuousPulseAt[channel] ?? 0;
    if (now - lastSentAt < refreshMs) {
      return false;
    }

    this.lastContinuousPulseAt[channel] = now;
    return true;
  }
}
