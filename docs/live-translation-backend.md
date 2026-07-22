# Real-time translation backend contract

In production mode, the desktop client never receives the iLiveData `secretKey`. The business API owns signing and returns short-lived, complete WebSocket URLs.

For provider comparison during desktop testing, the app also offers a direct iLiveData mode. That mode signs requests locally with credentials stored in the operating system keychain. It is test-only and must not be used as the production authentication path.

## Create or resume an epoch

`POST /api/business/translate/realtime/session`

```json
{
  "workspaceId": "optional-workspace-id",
  "sourceLanguage": "zh",
  "targetLanguage": "en",
  "sessionId": "optional-existing-session-id",
  "epoch": 0
}
```

```json
{
  "sessionId": "server-session-id",
  "epoch": 0,
  "expiresAt": "2026-07-22T12:00:00Z",
  "connections": [
    { "source": "mic", "url": "wss://…&userId=…-mic" },
    { "source": "system", "url": "wss://…&userId=…-system" }
  ]
}
```

Each URL must include the iLiveData authentication and recognition parameters, including `srcLanguage`, `destLanguage`, `asrResult=true`, `asrTempResult=true`, `transResult=true`, `ttsResult=false`, `codec=0`, and a source-specific anonymous `userId`. URLs should expire quickly and must not be logged with query parameters.

The backend must verify before release that the iLiveData project quota permits the two connections to run concurrently for one Lynse session. A single pre-mixed connection is not an acceptable fallback.

## Complete a session

`POST /api/business/translate/realtime/session/{sessionId}/complete`

```json
{
  "fileId": "uploaded-playback-file-id",
  "durationMs": 120000,
  "segments": [
    {
      "id": "…",
      "sessionId": "server-session-id",
      "epoch": 0,
      "source": "system",
      "recognizedText": "…",
      "translatedText": "…",
      "startMs": 1000,
      "endMs": 2400,
      "isFinal": true,
      "providerStreamId": "…",
      "taskId": "…"
    }
  ]
}
```

The endpoint should be idempotent by `sessionId`, associate the uploaded mixed WAV with the session, and persist the bilingual timeline. The desktop deletes raw `mic.wav` and `system.wav` recovery files only after this call succeeds.
