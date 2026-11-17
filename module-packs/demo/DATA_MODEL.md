# Demo: data model

What the Demo API stores and returns. Module key: `demo`. The same model is in `schema.json` as JSON Schema.

## Notes

A short note someone wrote. People reach notes by who wrote them, as far as their `note.*` scope goes: `own`, `team` (their reporting line) or `all`.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes | The note's id |
| `title` | string, 1 to 200 characters | yes | What the note is about |
| `body` | string, up to 5000 characters | yes | The text; empty when none was given |
| `status` | `open` or `done` | yes | New notes are `open` |
| `createdBy` | string | yes | The id of the person who wrote it |
| `createdAt` | date-time | yes | When it was written |
| `updatedAt` | date-time | yes | When it last changed |

| Status | Label | Pill tone |
|---|---|---|
| `open` | Open | neutral |
| `done` | Done | good |

Rules: anyone with `note.create` may write a note, which is theirs. Changing or deleting a note needs `note.update` or `note.delete` with a scope that reaches its writer. A delete is permanent.
