# pi-retain-cache

Keep supported Pi provider prompt caches warm during idle TUI sessions without showing the synthetic control exchange as normal conversation content.

## Requirements

- Pi with the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` runtime packages available.
- Node.js 20 or newer for the package development checks.
- TUI mode. Cache retention is not started in non-TUI modes.

The extension currently targets the `openai-codex` and `claude-bridge` providers. It does not read OAuth tokens or call provider HTTP endpoints directly. Retention requests go through Pi's normal selected-provider request path.

## Installation

```bash
pi install npm:@yukikisaku/pi-retain-cache
```

## Usage

After a normal conversation has completed, the extension starts an idle period. While all of the following remain true, it can send a hidden synthetic `<cache-retain/>` request at the configured interval:

- the extension is enabled;
- the active provider is in the configured provider list;
- Pi reports the agent as idle;
- there are no pending messages;
- the editor draft is empty; and
- the configured maximum idle duration has not been reached.

The model must answer exactly `<cache-retained/>`. The extension blocks tool calls during that synthetic retention turn. A timeout, tool call, model error, or unexpected response stops further retention until a later normal conversation completes.

By default, retention is enabled. `openai-codex` uses a 25-minute interval and `claude-bridge` uses a 50-minute interval; both stop after 120 minutes of idle time. Successful retention can show a compact `cache retained ×N` notice.

To change the interval, maximum idle duration, or notification visibility, run:

```text
/cache-retain
```

The extension hides the synthetic request/response from the normal conversation view and session tree by patching Pi's exported assistant-message and tree-selector UI component prototypes. It does not use a deep import into Pi's internal file layout.

## Configuration

Configuration is stored in the package-local `config.json`. The settings UI rewrites this file directly.

Because this file lives inside the installed npm package, reinstalling or updating the package can replace local configuration with the package defaults. Keep a copy of any values you want to restore after an update.

The initial configuration is:

```json
{
  "enabled": true,
  "intervalMinutes": 25,
  "maxIdleMinutes": 120,
  "requestTimeoutMinutes": 2,
  "providers": ["openai-codex", "claude-bridge"],
  "providerOverrides": {
    "claude-bridge": {
      "intervalMinutes": 50,
      "maxIdleMinutes": 120
    }
  },
  "showNotification": true
}
```

## Uninstallation

```bash
pi remove npm:@yukikisaku/pi-retain-cache
```

## Pull requests

Pull requests are reviewed by AI and automatically merged when the review and CI pass.

## License

MIT. See [LICENSE](LICENSE).
