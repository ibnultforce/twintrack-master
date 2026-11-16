# Test: data model

What the Test API returns. Module key: `test`. Its routes are `GET /test` and `GET /test/users`. It stores no records; the people come from Master.

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

## ColleagueList

The answer to `GET /test/users`.

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `people` | Colleague[] | yes | | One page, by name |
| `total` | number | yes | | How many people match, across every page |

## Colleague

An active colleague from Master's directory. Super admins are never listed.

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes | | The person's id |
| `name` | string | yes | | |
| `email` | string | yes | | |
| `title` | string | no | | Job title |
| `department` | string | no | | |
| `team` | string | no | | |
| `employeeNumber` | number | no | | |
| `photoUpdatedAt` | date-time | no | | When their photo last changed; missing when they have none |
| `online` | boolean | no | | Missing when the viewer's Master `presence.read` scope doesn't reach this person |

### Online

| Value | Label | Pill |
|---|---|---|
| `true` | Online | `good` |
| `false` | (nothing shown) | |

## Shared types

**Errors:** every error is `{ "error": { "code", "message", "fields"? } }`. Show `message`. Common codes: `401 no_token`, `403 forbidden`.
