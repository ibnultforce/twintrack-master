# Demo API

Notes, for trying a module's APIs, permissions and scopes. Module key `demo`, every path starts with `/demo`. Shared rules (tokens, errors, paging) are in the [API guide](README.md).

## Permissions

| Permission | Lets you |
|---|---|
| `note.read` | List and read notes |
| `note.create` | Write a note |
| `note.update` | Change a note |
| `note.delete` | Delete a note |

`note` is scoped by who wrote each note: `own` reaches your own notes, `team` adds everyone in your reporting line, `all` reaches every note. Only a super admin holds these until a profile grants them.

## A note

```json
{
  "id": "6f1c…",
  "title": "Try the Demo module",
  "body": "Written from Postman.",
  "status": "open",
  "createdBy": "u_01",
  "createdAt": "2026-11-17T10:00:00.000Z",
  "updatedAt": "2026-11-17T10:00:00.000Z"
}
```

`status` is `open` or `done`.

### `GET /demo/notes`

**Access:** `private`, needs `note.read`

**Query:** `page`, `pageSize` (up to 100, 25 by default), `status`

**Returns:** `notes` (newest first), `total`, `page`, `pageSize`, within your scope.

### `GET /demo/notes/:id`

**Access:** `private`, needs `note.read`

**Returns:** the note.

**Errors:** `404 note_not_found` (no such note, or beyond your scope)

### `POST /demo/notes`

**Access:** `private`, needs `note.create`

**Body:** `title` (1 to 200 characters), optional `body` (up to 5000)

**Returns:** `201` with the note, written by you.

**Errors:** `422 validation_failed`

### `PATCH /demo/notes/:id`

**Access:** `private`, needs `note.update`

**Body:** at least one of `title`, `body`, `status`

**Returns:** the changed note.

**Errors:** `404 note_not_found`, `422 validation_failed`

### `DELETE /demo/notes/:id`

**Access:** `private`, needs `note.delete`

**Returns:** `{ "deleted": true, "id": "…" }`. The note is gone for good.

**Errors:** `404 note_not_found`
