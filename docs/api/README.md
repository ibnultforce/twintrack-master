# TwinTrack API

Every module's API is served by the one Master backend. This guide covers what all modules share. Each module's routes are in its own file:

| Module | Built routes | Path prefix | Reference |
|---|---|---|---|
| Master | 33 | none | [master.md](master.md) |
| HR | 4 | `/hr` | [hr.md](hr.md) |
| Tasks | 52 | `/tasks` | [tasks.md](tasks.md) |
| Demo | 5 | `/demo` | [demo.md](demo.md) |
| Accounts | 5 | `/accounts` | [accounts.md](accounts.md) |

The local address is `http://api.twintrack.localhost:4100`. The examples below call it `$API`.

## Make your first call

Run the API first, as described in the [main README](../../README.md). The sample accounts are in `seed/users.json`, and their password is `SEED_PASSWORD` from `backend/.env`.

**1. Sign in.** The `Origin` header is required, and must be listed in `ALLOWED_ORIGINS`.

```sh
curl -i -X POST "$API/auth/login" \
  -H "Origin: http://twintrack.localhost:3100" \
  -H "Content-Type: application/json" \
  -d '{"email":"jack@twintrack.test","password":"YOUR_PASSWORD"}'
```

```json
{ "accessToken": "eyJ...", "expiresIn": 900 }
```

The response also sets the `twintrack_refresh` cookie.

**2. Send the token on each call.**

```sh
curl "$API/auth/me" -H "Authorization: Bearer eyJ..."
```

**3. When the token expires, refresh it.** Call `POST /auth/refresh` with the cookie and the same `Origin` header. You get a new access token and a new cookie.

Postman users can import the two files in `postman/` instead. On the optional test page at `/try`, you can sign in as any sample account and send any route. The [main README](../../README.md) explains both.

## Signing in from a module frontend

A module's frontend doesn't have its own sign-in. People sign in at the portal, and the portal hands them over with a one-time code, so the module works on any address: a subdomain, another domain or `localhost`.

1. **A super admin sets the module up** on the Modules screen (or `PUT /modules/:key/frontend`): its frontend address and its sign-in address, usually `<frontend address>/auth/callback`. The frontend address may then call the API.
2. **The person clicks Open** on the portal. The portal calls `POST /modules/<key>/handoff` and sends the browser to the sign-in address with `?code=…`. The code lasts 60 seconds and works once.
3. **The module's `/auth/callback` page** reads `code`, removes it from the address bar (`history.replaceState`), and exchanges it:

   ```sh
   curl -X POST "$API/auth/handoff"      -H "Origin: https://hr.twintrack.com"      -H "Content-Type: application/json"      -d '{"code":"…"}'
   ```

   ```json
   { "accessToken": "eyJ...", "expiresIn": 900, "module": "hr" }
   ```

   Keep the token in memory only, never in `localStorage`, and send it as `Authorization: Bearer …`.
4. **When a call answers `401`**, or the token is about to expire, send the browser to `<portal>/open/<module key>`. While the person's portal session lasts, this comes straight back to `/auth/callback` with a new code, without asking for a password. Otherwise they sign in first. Signing out of the portal ends the module's access too.

A module on a subdomain of the portal's own site may instead use `POST /auth/refresh` with the shared cookie, as the portal does.

## Who can call what

Each route declares one of three access levels:

| Access | What the API checks, in order |
|---|---|
| `public` | Nothing. Login, refresh and logout check the `Origin` header themselves. |
| `signed` | A valid token, an open session and an active account |
| `private` | The same as `signed`, then the named permission in that route's module |

A few `signed` routes, such as custom records, work out the caller's rights from their profile in the service. The module's doc notes which ones.

### How someone gets a permission

A permission is written `resource.action`, such as `salary.read`. A person holds one through any of these:

- **Super admin:** every permission in every module.
- **Profile:** one per person, org-wide, and the only place their permissions come from. Given with `PUT /users/:id/profile`, which needs `userProfile.update` and stays within the giver's own access and reach. `GET /access-profiles` lists them.

Changes apply on the person's next request, because the token holds only their identity. No profiles ship with the product, so only a super admin has access until they create some.

### Scope

Some permissions reach only certain people. If someone has the same permission more than once, the widest scope counts.

| Scope | Reaches |
|---|---|
| `own` | The caller |
| `team` | The caller and everyone who reports to them, directly or through others (`managerId`). Org roles play no part |
| `all` | Everyone |

## Tokens and sessions

| Setting | Default |
|---|---|
| Access token lifetime | 15 minutes |
| Session ends after no use | 7 days |
| Session ends regardless | 30 days |
| Failed logins or password changes before a block | 10 per address in 15 minutes |

Each refresh replaces the refresh cookie. A cookie that was just replaced keeps working for 10 seconds, so two open tabs can refresh together. Using an older one ends the whole session.

## Requests and responses

- Bodies are JSON, up to 256 KB. Unknown fields are refused on routes that take specific fields.
- Paged lists take `page` (default 1) and `pageSize` (default 25, maximum 100), and return a `total`.

Every error has the same shape. `fields` appears on validation errors:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some fields are invalid.",
    "fields": [{ "path": "email", "message": "must be a valid email address" }]
  }
}
```

### Errors any route can return

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | The request couldn't be read, such as broken JSON |
| 401 | `no_token` | No access token was sent (`signed` and `private` routes) |
| 401 | `invalid_token`, `token_expired` | The token is bad or expired. Refresh and try again. |
| 401 | `session_revoked` | The session has ended. Sign in again. |
| 401 | `account_inactive` | The account has been deactivated |
| 403 | `forbidden` | The caller lacks the permission |
| 404 | `no_route` | No such route |
| 422 | `validation_failed` | A field is invalid. See `fields`. |
| 500 | `server_error` | Unexpected failure. Details go to the server log only. |

The module files list only the errors specific to each route.

## Keeping these files current

Update the module's file in the same change as any route. To add a module, add a file here and a row to the table above.
