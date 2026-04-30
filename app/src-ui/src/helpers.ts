import {
  API_BASE,
  type ProviderDraft,
  type ProviderSummary,
  type ShockPlanRecord,
  type UiState
} from "./api";

export const providerPresets: Record<string, Partial<ProviderDraft>> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com"
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com"
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta"
  }
};

export function summarizeState(state: UiState) {
  const events = state.events ?? [];
  const plans = state.shockPlans ?? [];
  return {
    events: events.length,
    plans: plans.length,
    sent: plans.filter((plan) => plan.outcome === "sent").length,
    blocked: plans.filter((plan) => plan.outcome === "blocked" || plan.outcome === "error").length
  };
}

export function providerLabel(state: UiState): string {
  const upstream = state.upstream;
  return `上游: ${upstream.name ?? "未配置"} · ${upstream.protocol ?? "openai"} · ${upstream.baseUrl ?? ""}`;
}

export function downstreamApiUrl(): string {
  if (API_BASE.startsWith("http")) {
    return `${API_BASE.replace(/\/$/, "")}/v1`;
  }
  return new URL("/v1", window.location.href).toString().replace(/\/$/, "");
}

export function dglabLinkLabel(state: UiState): string {
  if (!state.dglab.enabled) return "DG-LAB 未启用";
  if (state.dglab.bound) return "APP 已配对";
  if (state.dglab.connected) return "Socket 已连接";
  return "未连接";
}

export function outputModeLabel(state: UiState): string {
  return state.safety.dryRun ? "预览模式" : "设备输出";
}

export function feedbackLabel(state: UiState): string {
  if (state.safety.panic) return "Panic 锁定";
  return state.safety.armed ? "运行中" : "等待启动";
}

export function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function matchingPreset(provider: ProviderDraft): string {
  if (provider.protocol === "openai" && provider.baseUrl === "https://api.openai.com") return "openai";
  if (provider.protocol === "anthropic" && provider.baseUrl === "https://api.anthropic.com") return "anthropic";
  if (provider.protocol === "gemini" && provider.baseUrl === "https://generativelanguage.googleapis.com/v1beta") return "gemini";
  return "custom";
}

export function uniqueProviderId(seed: string, providers: ProviderSummary[] | undefined): string {
  const base =
    seed
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "custom";
  const ids = new Set((providers ?? []).map((provider) => provider.id));
  if (!ids.has(base)) return base;
  let index = 2;
  while (ids.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function eventDetail(event: UiState["events"][number]): string {
  if (event.type === "request.started") {
    return event.model ? `模型 ${event.model}` : "请求已开始";
  }
  if (event.type === "request.body_seen") {
    const stream = event.stream ? "流式请求" : "普通请求";
    const endpoint = event.endpoint ? ` · 接口 ${event.endpoint}` : "";
    return `请求体 ${formatBytes(event.bytes)} · ${stream}${endpoint}`;
  }
  if (event.type === "response.started") {
    return event.model ? `模型 ${event.model}` : "上游已开始响应";
  }
  if (event.type === "response.chunk") {
    const cumulative = event.cumulativeChars !== undefined ? ` · 累计 ${event.cumulativeChars} 个字符` : "";
    return `收到 ${event.chars ?? 0} 个字符 · ${formatBytes(event.bytes)}${cumulative}`;
  }
  if (event.type === "response.tool_call") {
    const count = event.toolCallCount ?? 1;
    const names = event.toolNames?.length ? ` · ${event.toolNames.join("、")}` : "";
    return `工具调用 ${count} 次${names}`;
  }
  if (event.type === "response.done") {
    const status = event.statusCode ? `状态 ${event.statusCode}` : "响应完成";
    const duration = event.durationMs !== undefined ? ` · 用时 ${formatDuration(event.durationMs)}` : "";
    const chars = event.chars !== undefined ? ` · ${event.chars} 个字符` : "";
    const tokens = event.outputTokens !== undefined ? ` · 输出 ${event.outputTokens} 个令牌` : "";
    return `${status}${duration}${chars}${tokens}`;
  }
  if (event.type === "response.error_status") {
    const status = event.statusCode ? `状态 ${event.statusCode}` : "错误状态";
    const detail = event.message ? ` · ${formatDiagnostic(event.message)}` : "";
    return `${status}${detail}`;
  }
  if (event.type === "response.error" || event.type === "response.aborted") {
    return event.message ? formatDiagnostic(event.message) : eventTypeLabel(event.type);
  }
  if (event.type.startsWith("dglab.") || event.type.startsWith("safety.")) {
    return eventTypeLabel(event.type);
  }
  if (event.model) return `模型 ${event.model}`;
  if (event.chars !== undefined) return `${event.chars} 个字符`;
  if (event.bytes !== undefined) return formatBytes(event.bytes);
  if (event.message) return formatDiagnostic(event.message);
  if (event.endpoint) return `接口 ${event.endpoint}`;
  return event.requestId ?? "";
}

export function planDetail(record: ShockPlanRecord): string {
  const plan = record.output ?? record.input ?? {};
  const channel = plan.channel ? `${plan.channel} 通道` : "无通道";
  const intensity = `${Math.round(Number(plan.intensity ?? 0) * 100)}%`;
  const duration = formatDuration(plan.durationMs ?? 0);
  const wave = plan.waveId ? ` · 波形 ${plan.waveId}` : "";
  const suffix = record.error ? ` · ${formatDiagnostic(record.error)}` : "";
  const outcome = record.safety?.dryRun && record.outcome === "sent" ? "预览记录" : planOutcomeLabel(record.outcome);
  return `${outcome} · ${channel} · 强度 ${intensity} · ${duration}${wave}${suffix}`;
}

export function eventTypeLabel(type: string | undefined): string {
  if (!type) return "";
  return eventTypeLabels[type] ?? type;
}

export function planOutcomeLabel(outcome: string): string {
  return planOutcomeLabels[outcome] ?? outcome;
}

function formatBytes(bytes: number | undefined): string {
  return `${bytes ?? 0} 字节`;
}

function formatDuration(durationMs: number): string {
  return `${durationMs} 毫秒`;
}

function formatDiagnostic(message: string): string {
  return diagnosticLabels[message] ?? message;
}

const eventTypeLabels: Record<string, string> = {
  "request.started": "请求开始",
  "request.body_seen": "请求体已记录",
  "response.started": "响应开始",
  "response.chunk": "响应片段",
  "response.done": "响应完成",
  "response.tool_call": "工具调用",
  "response.error_status": "错误状态",
  "response.error": "响应错误",
  "response.aborted": "响应中断",
  "dglab.connected": "DG-LAB 已连接",
  "dglab.bound": "APP 已配对",
  "dglab.disconnected": "DG-LAB 已断开",
  "dglab.feedback": "设备反馈",
  "dglab.strength_report": "强度上报",
  "dglab.test": "测试电击",
  "safety.armed": "安全门已启动",
  "safety.disarmed": "安全门已停止",
  "safety.panic": "紧急停止"
};

const planOutcomeLabels: Record<string, string> = {
  sent: "已发送",
  blocked: "已拦截",
  dry_run: "预览记录",
  error: "出错"
};

const diagnosticLabels: Record<string, string> = {
  dglab_disabled: "DG-LAB 未启用",
  dglab_not_bound: "DG-LAB 尚未完成 APP 配对",
  missing_channel: "缺少输出通道",
  safety_blocked: "被安全限制拦截",
  upstream_error: "上游请求出错"
};

export function newestFirst<T extends { timestamp: number }>(items: T[] | undefined): T[] {
  return [...(items ?? [])].reverse();
}
