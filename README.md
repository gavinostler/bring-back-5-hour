# bring-back-5-hour

A self-imposed 5-hour usage limit for Claude Code.

Usage is estimated from your local transcripts at API prices. A window opens on your first message and lasts 5 hours. Once your budget is spent, prompts are blocked until the window resets.

No dependencies. Requires Node 18+.

## Install

Clone the repo, then add the hook and status line to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/five-hour.mjs hook", "timeout": 30 }] }
    ]
  },
  "statusLine": { "type": "command", "command": "node /path/to/five-hour.mjs statusline" }
}
```

Optional MCP server, so Claude can check usage or bypass on request:

```sh
claude mcp add five-hour -s user -- node /path/to/five-hour.mjs mcp
```

## Commands

```
node five-hour.mjs status              current window
node five-hour.mjs history             last 48h of windows
node five-hour.mjs calibrate [--apply] budget from your past real limit hits
node five-hour.mjs budget [usd]        get or set budget per window (default $150)
node five-hour.mjs off [hours]         bypass (default: rest of window)
node five-hour.mjs on                  end bypass
```

Start a message with `!bypass` to lift the limit for the rest of the window. Set `FIVE_HOUR_BYPASS=1` to disable it entirely.
