# Safety Guide

CoyoteCoder defaults to dry-run mode. Keep dry-run enabled until the proxy, DG-LAB pairing, and event flow have all been verified.

## Default Safe State

- `safety.dry_run: true` means shock plans are produced and recorded, but real DG-LAB output is not sent.
- `safety.armed: false` means real output is blocked even if dry-run is disabled.
- `POST /control/panic` disarms the system, recalls any queued pulse forwards, and commands both channels to zero directly — it does not depend on the event pipeline being healthy.
- `panic_zero_on_exit: true` makes shutdown drain queued sends, zero both channels, wait for the frames to actually leave the socket, and only then drop the transports. `SIGINT`, `SIGTERM`, `SIGBREAK`, and an uncaught exception all take this path.
- Custom waveforms and continuous streaming plans still pass through `SafetyGate` before any real output is sent.

## Layered Limits

`SafetyGate` applies these in order. Everything except the zero/clear path is subject to all of them:

| Layer | Setting | Behaviour |
| --- | --- | --- |
| Panic latch | — | Blocks everything until `POST /control/arm` |
| Arm state | `safety.armed` | Real output requires an explicit arm |
| Session ceiling | `safety.max_session_ms` | Auto-disarms after this long armed; `0` disables |
| Idle ceiling | `safety.idle_disarm_ms` | Auto-disarms after this long without events; `0` disables |
| Spacing | `safety.min_interval_ms` | Minimum gap between discrete plans per channel; continuous stream refreshes are exempt |
| Rate limit | `safety.max_events_per_minute` | Sliding 60s window |
| Intensity ceiling | `safety.channel_limits` ∩ device soft limit | The stricter of the two wins when `respect_device_soft_limit` is on |
| Ramp | `safety.max_intensity_step` | Largest increase a single plan may apply per channel |
| Duration | `safety.max_continuous_output_ms` | Caps plan duration |

An auto-disarm (session expiry, idle timeout, or the DG-LAB link dropping) also zeroes the device rather than only flipping a flag. Losing the WebSocket link disarms the session: an armed state must not outlive the path that carries its output.

## Preflight Checklist

1. Start CoyoteCoder with `safety.dry_run: true`.
2. Open `http://127.0.0.1:8787/ui`.
3. Confirm the header shows `Dry-run 开启` and `反馈已停止`.
4. Run a dry request through `http://127.0.0.1:8787/v1`.
5. Check `GET /events/recent` for lifecycle events.
6. Check `GET /shock/recent` for generated plans and Safety outcomes.
7. Pair DG-LAB only after the dry-run path is visible and stable.

## Pairing Flow

1. Start the official DG-LAB Socket V2 backend.
2. Keep `dglab.enabled: true`, which is the default.
3. Keep `dglab.qr_host: auto` unless you need to force a specific LAN address.
4. Keep `safety.dry_run: true`.
5. Request `GET /dglab/qr` or click `生成配对码` in the UI.
6. Scan the QR code with the APP.
7. Confirm `GET /dglab/status` reports `bound: true`.
8. Send one more dry-run request and confirm no real output is sent.

## Real Output Gate

Only test real output after the dry-run and pairing checks pass.

1. Set conservative channel limits in the UI.
2. Click `启动反馈` or call `POST /control/arm`.
3. Disable Dry-run only for the active test window.
4. Keep the UI open with the `紧急停止` button visible.
5. Re-enable Dry-run or click `停止反馈` immediately after the test.

流式输出会合并高频 chunk，减少连续输出过密触发限流的概率；这只是体验优化，不替代 Safety 上限。

## Emergency Stop

Use any available panic path:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8787/control/panic
```

Panic sets `armed` to false, enters panic state, cancels queued pulse forwards, and commands both channels to zero. After panic, call `POST /control/arm` only when you intentionally want to resume testing.

`POST /ui/stop` (and the tray's 暂停反馈) disarms and zeroes but keeps the DG-LAB pairing, so resuming does not require re-scanning the QR code. Use `POST /ui/disconnect` when you want to drop the pairing as well.

## Observability

Use these endpoints while tuning:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/status
Invoke-RestMethod http://127.0.0.1:8787/events/recent
Invoke-RestMethod http://127.0.0.1:8787/shock/recent
Invoke-RestMethod http://127.0.0.1:8787/dglab/status
```

`/shock/recent` reports the raw plan from policy, the Safety-adjusted output when allowed, and whether the plan was sent, blocked, or errored.
