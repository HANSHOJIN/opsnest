# Architecture Notes

```text
React UI
   ↓ invoke/events
Tauri commands
   ↓
Safety Gateway
   ├─ policy checks
   ├─ redaction
   ├─ approval state
   └─ audit timeline
   ↓
SSH Core / Model Provider
```

The Agent must never call an unrestricted shell directly. It should select typed, narrow tools such as `inspect_service`, `read_logs`, `check_disk`, and `restart_service`. Mutating tools declare a risk level and approval requirement.
