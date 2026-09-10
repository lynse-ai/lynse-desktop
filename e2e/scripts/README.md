# Chat scripts (structured, editable)

Each JSON file is a replayable AI-assistant conversation script. Edit, add or
delete files freely — the multiturn spec automatically picks up every file with
`"suite": "multiturn"`.

## Fields

```jsonc
{
  "name": "my-script",            // must match the file name
  "suite": "multiturn",           // "multiturn" (auto-run) or "core" (used by core specs)
  "locale": "en",                 // informational
  "description": "...",
  "turns": [
    {
      "user": "typed text",       // what gets typed into the composer
      "quickPrompt": "chat.quick_todos",  // optional: click this quick chip instead of typing
      "response": { ... }         // scripted assistant reply
    }
  ]
}
```

## Response types (`response.type`)

| type          | behavior                                                                   |
| ------------- | -------------------------------------------------------------------------- |
| `stream`      | SSE content chunks streamed with `chunkDelayMs` delay; optional `status` tick and `sources` chips; ends with `done`. |
| `clarify`     | Emits a `confirm` event → the app pops the Confirmation dialog with `options`; the harness clicks an option, which sends the next `user` turn. |
| `error`       | SSE `error` event → error bubble in the UI.                                |
| `stream-abort`| Streams chunks slowly and never sends `done` — used to exercise the **Stop** button (harness clicks Stop). |
| `http-error`  | Fails at HTTP level (`status`) instead of via SSE.                          |

Special `user` value: a string starting with `MENTION:` is handled by the
mentions spec (types the trigger, drives the picker) — plain multiturn replay
sends it verbatim, so keep such turns in scripts only used by that spec.

## Rules for multiturn scripts

- At least 5 turns.
- `stream` responses: the final text must equal `chunks.join("")` — the harness
  asserts exactly that.
- Turns are replayed **per conversation (sessionId)** in order; a fresh chat
  resets the counter.
