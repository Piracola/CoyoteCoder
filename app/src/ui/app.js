const $ = (id) => document.getElementById(id);

let refreshTimer;
let currentState;

const fields = {
  providerPreset: $("providerPreset"),
  providerSelect: $("providerSelect"),
  providerName: $("providerName"),
  providerProtocol: $("providerProtocol"),
  providerBaseUrl: $("providerBaseUrl"),
  providerKey: $("providerKey"),
  providerTimeout: $("providerTimeout"),
  limitA: $("limitA"),
  limitB: $("limitB"),
  maxContinuous: $("maxContinuous"),
  maxPerMinute: $("maxPerMinute"),
  requestChannel: $("requestChannel"),
  requestCoefficient: $("requestCoefficient"),
  requestDuration: $("requestDuration"),
  startedChannel: $("startedChannel"),
  startedCoefficient: $("startedCoefficient"),
  startedDuration: $("startedDuration"),
  chunkChannel: $("chunkChannel"),
  chunkCoefficient: $("chunkCoefficient"),
  chunkMicroIntensity: $("chunkMicroIntensity"),
  chunkDuration: $("chunkDuration"),
  toolChannel: $("toolChannel"),
  toolCoefficient: $("toolCoefficient"),
  toolDuration: $("toolDuration"),
  errorStatusChannel: $("errorStatusChannel"),
  errorStatusCoefficient: $("errorStatusCoefficient"),
  errorStatusDuration: $("errorStatusDuration"),
  doneChannel: $("doneChannel"),
  doneCoefficient: $("doneCoefficient"),
  doneDuration: $("doneDuration")
};

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, {
    ...options,
    headers
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? payload?.message ?? `请求失败: ${response.status}`);
  }
  return payload;
}

async function refresh({ quiet = false } = {}) {
  try {
    const state = await api("/ui/state");
    render(state);
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  }
}

function render(state) {
  currentState = state;
  renderStatus(state);
  renderProvider(state);
  renderSettings(state);
  renderQr(state);
  renderEvents(state.events ?? []);
  renderShockPlans(state.shockPlans ?? []);
}

function renderStatus(state) {
  const upstream = state.upstream ?? {};
  $("upstreamText").textContent = `上游: ${upstream.name ?? "未配置"} · ${upstream.protocol ?? "openai"} · ${upstream.baseUrl ?? ""}`;
  setPill($("dryRunPill"), state.safety.dryRun ? "预览模式" : "设备输出", state.safety.dryRun ? "warn" : "danger");
  setPill($("armedPill"), state.safety.armed ? "反馈已启动" : "反馈已停止", state.safety.armed ? "ok" : "");
  setPill(
    $("dglabPill"),
    state.dglab.bound ? "DG-LAB 已配对" : state.dglab.connected ? "DG-LAB 已连接" : "DG-LAB 未连接",
    state.dglab.bound ? "ok" : state.dglab.connected ? "warn" : ""
  );
  $("dryRunToggle").checked = state.safety.dryRun;
  $("startBtn").disabled = state.safety.armed;
  $("stopBtn").disabled = !state.safety.armed && !state.dglab.connected;
  $("connectBtn").disabled = !state.dglab.enabled || state.dglab.connected;
  $("disconnectBtn").disabled = !state.dglab.connected;
  $("qrBtn").disabled = !state.dglab.enabled;
}

function setPill(element, text, mode) {
  element.textContent = text;
  element.className = `pill ${mode}`.trim();
}

function renderSettings(state) {
  if ($("settingsForm").contains(document.activeElement)) {
    return;
  }

  const safety = state.safety;
  const policy = state.policy;

  fields.limitA.value = safety.channelLimits.A;
  fields.limitB.value = safety.channelLimits.B;
  fields.maxContinuous.value = safety.maxContinuousOutputMs;
  fields.maxPerMinute.value = safety.maxEventsPerMinute;

  setPulse("request", policy.requestStarted);
  setPulse("started", policy.responseStarted);
  setPulse("tool", policy.responseToolCall);
  setPulse("errorStatus", policy.responseErrorStatus);
  setPulse("done", policy.responseDone);

  fields.chunkChannel.value = policy.responseChunk.channel;
  fields.chunkCoefficient.value = policy.responseChunk.coefficient;
  fields.chunkMicroIntensity.value = policy.responseChunk.microIntensity;
  fields.chunkDuration.value = policy.responseChunk.durationMs;
}

function renderProvider(state) {
  if ($("providerForm").contains(document.activeElement)) {
    return;
  }

  const upstream = state.upstream ?? {};
  const providers = upstream.providers ?? [];
  fields.providerSelect.innerHTML = "";
  if (fields.providerSelect.dataset.draftId) {
    fields.providerSelect.add(new Option(fields.providerName.value || "未保存供应商", fields.providerSelect.dataset.draftId));
  }
  for (const provider of providers) {
    fields.providerSelect.add(new Option(provider.name, provider.id));
  }
  fields.providerSelect.value = fields.providerSelect.dataset.draftId || upstream.activeProvider || providers[0]?.id || "";
  $("deleteProviderBtn").disabled = providers.length <= 1 || Boolean(fields.providerSelect.dataset.draftId);
  fields.providerPreset.value = matchingPreset(upstream);
  fields.providerName.value = upstream.name ?? "";
  fields.providerProtocol.value = upstream.protocol ?? "openai";
  fields.providerBaseUrl.value = upstream.baseUrl ?? "";
  fields.providerKey.value = "";
  fields.providerKey.placeholder = upstream.hasApiKey ? "已配置，留空不修改" : "保存在配置文件中";
  fields.providerTimeout.value = upstream.timeoutMs ?? 120000;
}

function matchingPreset(upstream) {
  if (upstream.protocol === "openai" && upstream.baseUrl === "https://api.openai.com") return "openai";
  if (upstream.protocol === "anthropic" && upstream.baseUrl === "https://api.anthropic.com") return "anthropic";
  if (upstream.protocol === "gemini" && upstream.baseUrl === "https://generativelanguage.googleapis.com/v1beta") return "gemini";
  return "custom";
}

function uniqueProviderId(seed, providers) {
  const base = seed
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

function setPulse(prefix, pulse) {
  fields[`${prefix}Channel`].value = pulse.channel;
  fields[`${prefix}Coefficient`].value = pulse.coefficient;
  fields[`${prefix}Duration`].value = pulse.durationMs;
}

function renderQr(state) {
  const img = $("qrImage");
  const placeholder = $("qrBox").querySelector("span");
  const link = state.dglab.qrLink;

  if (!state.dglab.enabled) {
    img.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = "DG-LAB 未启用";
    $("qrLinkText").textContent = "在配置中启用 dglab.enabled 后可生成配对码";
    return;
  }

  if (link) {
    if (!img.getAttribute("src")) {
      img.src = `/ui/qr.svg?t=${Date.now()}`;
    }
    img.hidden = false;
    placeholder.hidden = true;
    $("qrLinkText").textContent = link;
    return;
  }

  img.hidden = true;
  placeholder.hidden = false;
  placeholder.textContent = state.dglab.connected ? "等待 clientId" : "等待生成";
  $("qrLinkText").textContent = state.dglab.lastError ? `错误: ${state.dglab.lastError}` : "未获取 clientId";
}

function renderEvents(events) {
  $("eventCount").textContent = String(events.length);
  const container = $("events");
  container.replaceChildren();

  if (events.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "暂无事件";
    container.append(empty);
    return;
  }

  for (const event of [...events].reverse()) {
    const row = document.createElement("div");
    row.className = "event";

    const type = document.createElement("strong");
    type.textContent = event.type;
    const detail = document.createElement("span");
    detail.textContent = eventDetail(event);
    const time = document.createElement("span");
    time.textContent = new Date(event.timestamp).toLocaleTimeString();

    row.append(type, detail, time);
    container.append(row);
  }
}

function eventDetail(event) {
  if (event.model) return event.model;
  if (event.chars !== undefined) return `${event.chars} chars`;
  if (event.bytes !== undefined) return `${event.bytes} bytes`;
  if (event.message) return event.message;
  return event.requestId ?? "";
}

function renderShockPlans(plans) {
  $("planCount").textContent = String(plans.length);
  const container = $("shockPlans");
  container.replaceChildren();

  if (plans.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "暂无计划";
    container.append(empty);
    return;
  }

  for (const plan of [...plans].reverse()) {
    const row = document.createElement("div");
    row.className = `shock-plan ${plan.outcome}`;

    const reason = document.createElement("strong");
    reason.textContent = plan.eventType;

    const detail = document.createElement("span");
    detail.textContent = shockPlanDetail(plan);

    const time = document.createElement("span");
    time.textContent = new Date(plan.timestamp).toLocaleTimeString();

    row.append(reason, detail, time);
    container.append(row);
  }
}

function shockPlanDetail(record) {
  const plan = record.output ?? record.input;
  const channel = plan.channel ? `${plan.channel} 通道` : "无通道";
  const intensity = `${Math.round(Number(plan.intensity ?? 0) * 100)}%`;
  const duration = `${plan.durationMs ?? 0}ms`;
  const suffix = record.error ? ` · ${record.error}` : "";
  return `${record.outcome} · ${channel} · ${intensity} · ${duration}${suffix}`;
}

function collectSettings() {
  return {
    dryRun: $("dryRunToggle").checked,
    safety: {
      channelLimits: {
        A: numberValue(fields.limitA),
        B: numberValue(fields.limitB)
      },
      maxContinuousOutputMs: numberValue(fields.maxContinuous),
      maxEventsPerMinute: numberValue(fields.maxPerMinute)
    },
    policy: {
      requestStarted: getPulse("request"),
      responseStarted: getPulse("started"),
      responseChunk: {
        channel: fields.chunkChannel.value,
        coefficient: numberValue(fields.chunkCoefficient),
        microIntensity: numberValue(fields.chunkMicroIntensity),
        durationMs: numberValue(fields.chunkDuration)
      },
      responseToolCall: getPulse("tool"),
      responseErrorStatus: getPulse("errorStatus"),
      responseDone: getPulse("done")
    }
  };
}

function collectProvider() {
  const payload = {
    id: fields.providerSelect.dataset.draftId || fields.providerSelect.value,
    name: fields.providerName.value.trim(),
    protocol: fields.providerProtocol.value,
    baseUrl: fields.providerBaseUrl.value.trim(),
    timeoutMs: numberValue(fields.providerTimeout)
  };
  if (fields.providerKey.value.trim()) {
    payload.apiKey = fields.providerKey.value.trim();
  }
  return { upstream: payload };
}

function getPulse(prefix) {
  return {
    channel: fields[`${prefix}Channel`].value,
    coefficient: numberValue(fields[`${prefix}Coefficient`]),
    durationMs: numberValue(fields[`${prefix}Duration`])
  };
}

function numberValue(input) {
  return Number(input.value);
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.background = isError ? "#992f2b" : "#172033";
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

async function runAction(label, fn) {
  try {
    const state = await fn();
    if (state?.ok) render(state);
    showToast(label);
  } catch (error) {
    showToast(error.message, true);
  }
}

$("refreshBtn").addEventListener("click", () => refresh());
fields.providerSelect.addEventListener("change", () => {
  delete fields.providerSelect.dataset.draftId;
  runAction("供应商已切换", () =>
    api("/ui/upstream", {
      method: "POST",
      body: JSON.stringify({ action: "select", id: fields.providerSelect.value })
    })
  );
});
$("newProviderBtn").addEventListener("click", () => {
  const id = uniqueProviderId("custom", currentState?.upstream?.providers ?? []);
  fields.providerSelect.dataset.draftId = id;
  fields.providerSelect.innerHTML = "";
  fields.providerSelect.add(new Option("自定义供应商", id));
  fields.providerName.value = "自定义供应商";
  fields.providerProtocol.value = "openai";
  fields.providerBaseUrl.value = "https://api.openai.com";
  fields.providerKey.value = "";
  fields.providerTimeout.value = 120000;
  $("deleteProviderBtn").disabled = true;
});
$("providerPreset").addEventListener("change", () => {
  const presets = {
    openai: {
      name: "OpenAI",
      protocol: "openai",
      baseUrl: "https://api.openai.com"
    },
    anthropic: {
      name: "Anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com"
    },
    gemini: {
      name: "Gemini",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta"
    }
  };
  const preset = presets[$("providerPreset").value];
  if (!preset) return;
  fields.providerName.value = preset.name;
  fields.providerProtocol.value = preset.protocol;
  fields.providerBaseUrl.value = preset.baseUrl;
});
$("saveProviderBtn").addEventListener("click", () =>
  runAction("供应商已保存", () =>
    api("/ui/upstream", {
      method: "POST",
      body: JSON.stringify(collectProvider())
    })
  )
);
$("deleteProviderBtn").addEventListener("click", () =>
  runAction("供应商已删除", () =>
    api("/ui/upstream", {
      method: "POST",
      body: JSON.stringify({ action: "delete", id: fields.providerSelect.value })
    })
  )
);
$("startBtn").addEventListener("click", () => runAction("反馈已启动", () => api("/ui/start", { method: "POST" })));
$("stopBtn").addEventListener("click", () => runAction("反馈已停止", () => api("/ui/stop", { method: "POST" })));
$("panicBtn").addEventListener("click", () =>
  runAction("已执行紧急停止", async () => {
    await api("/control/panic", { method: "POST" });
    return api("/ui/state");
  })
);
$("connectBtn").addEventListener("click", () =>
  runAction("DG-LAB 已连接", async () => {
    await api("/dglab/connect", { method: "POST" });
    return api("/ui/state");
  })
);
$("disconnectBtn").addEventListener("click", () =>
  runAction("DG-LAB 已断开", async () => {
    await api("/dglab/disconnect", { method: "POST" });
    return api("/ui/state");
  })
);
$("qrBtn").addEventListener("click", () =>
  runAction("配对码已更新", async () => {
    await api("/dglab/qr");
    const state = await api("/ui/state");
    $("qrImage").src = `/ui/qr.svg?t=${Date.now()}`;
    return state;
  })
);
$("dryRunToggle").addEventListener("change", () =>
  runAction("预览模式已更新", () =>
    api("/ui/settings", {
      method: "POST",
      body: JSON.stringify({ dryRun: $("dryRunToggle").checked })
    })
  )
);
$("saveBtn").addEventListener("click", () =>
  runAction("参数已保存", () =>
    api("/ui/settings", {
      method: "POST",
      body: JSON.stringify(collectSettings())
    })
  )
);
$("resetDefaultsBtn").addEventListener("click", () =>
  runAction("已恢复默认参数", () =>
    api("/ui/settings", {
      method: "POST",
      body: JSON.stringify({ action: "reset-defaults" })
    })
  )
);

window.addEventListener("focus", () => refresh({ quiet: true }));
refresh();
refreshTimer = window.setInterval(() => refresh({ quiet: true }), 3000);
window.addEventListener("beforeunload", () => window.clearInterval(refreshTimer));
