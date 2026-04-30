# Protocol Notes

This project treats DG-LAB's official open-source repository as an external reference:

```text
DG-LAB-OPENSOURCE/
```

That directory remains ignored by this repository so it can be updated independently from the official source.

CoyoteCoder now includes a DG-LAB Socket V2 controller path:

1. OpenAI-compatible downstream traffic enters through `http://127.0.0.1:8787/v1`.
2. Chat, responses, and completions requests emit normalized lifecycle events.
3. `ShockPolicy` converts those events into channel plans.
4. `SafetyGate` clamps, blocks, or panic-stops plans before any sink receives them.
5. `DglabSink` sends allowed plans through the Socket V2 controller when DG-LAB is enabled.

The default state is still safe: `safety.dry_run: true` and `safety.armed: false`. Real device output requires disabling dry-run and arming feedback intentionally.

CoyoteCoder can load DG-LAB V3 waveform files from `waveforms/` or `COYOTE_WAVEFORMS_DIR`. Policy entries may reference a `waveform_id`; missing IDs fall back to built-in waveforms.

Useful protocol references:

```text
DG-LAB-OPENSOURCE/socket/v2/README.md
DG-LAB-OPENSOURCE/socket/v2/backend
DG-LAB-OPENSOURCE/socket/DG_WAVES_V2_V3_simple.js
```
