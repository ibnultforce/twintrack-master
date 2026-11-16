# Test: data model

What the Test API returns. Module key: `test`. Its one route is `GET /test`. It stores no records.

The same model is in `schema.json` as JSON Schema. Routes and error codes are in `api/test.md`.

## Reading this document

- **Type** uses JSON types. `date-time` is an ISO 8601 string such as `2026-11-13T09:30:00.000Z`.
- **Always** means the field is in every response.

## Who reaches it

`test.read` is not scoped: a person holds it or doesn't. The API checks it; the screen only hides what the person can't use.

## TestResult

The answer to `GET /test`.

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `status` | TestStatus | yes | | |
| `module` | string | yes | | Always `test` |
| `time` | date-time | yes | | The server's time when it answered |

### TestStatus

| Value | Label | Pill |
|---|---|---|
| `ok` | OK | `good` |

## Shared types

**Errors:** every error is `{ "error": { "code", "message", "fields"? } }`. Show `message`. Common codes: `401 no_token`, `403 forbidden`.
