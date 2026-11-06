# twintrack-master

The TwinTrack Master module: login, users and permissions, and the API behind every module.

| App | Folder | Local address |
|---|---|---|
| Backend API (Express, Mongoose) | `backend` | http://api.twintrack.localhost:4100 |
| Frontend (Next.js) | `frontend` | http://twintrack.localhost:3100 |

## Requirements

- Node.js 22 or newer
- MongoDB running locally as a replica set, because the API uses transactions:
  - Add `replication: { replSetName: rs0 }` to `mongod.cfg` and restart the service.
  - Run `rs.initiate({_id: 'rs0', members: [{_id: 0, host: '127.0.0.1:27017'}]})` once in `mongosh`.

## Run it

```sh
npm install
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
npm run seed
npm run dev
```

Open http://twintrack.localhost:3100. The page should say "API and database connected".

## Example data

`npm run seed` loads the Master and HR modules and the 10-person example team from `seed/`. Everyone's password is `SEED_PASSWORD` from `backend/.env`, and the seed stops if that isn't set.

- **Safe to re-run:** it updates records by id and creates no duplicates. It resets each person's roles and privileges to what the files say, and keeps passwords already set.
- **All or nothing:** every file is checked first and all problems are listed together. If anything fails, nothing is saved.
- **Development only:** it refuses to run when `NODE_ENV` is `production`.

## Backend layout

All module backends live in this repo, each in its own folder under `backend/src/modules/`. Inside a module, each feature has its own folder, split by job:

| File | Job |
|---|---|
| `*.routes.ts` | HTTP only: reads the request and sends the response |
| `*.service.ts` | Rules and workflows |
| `*.repository.ts` | Database queries |

Mongoose schemas are in the module's `models/` folder. Code shared between modules is in `backend/src/lib/`. `backend/src/seed/` loads example data across modules.

## Manifests

`manifests/` has one file per module: `master`, `hr`, `employee` and `account`. Each lists that module's resources, routes and fixed role templates. Like `postman/`, this folder is ignored by git, so it has to be added by hand on a new machine, and `npm run seed` and `npm test` need it. The seed loads only Master and HR for now, and a test checks that every file in the folder is valid.

Update a module's manifest in the same change as any of its routes. A route marked `"planned": true` is designed but not built yet, so remove the flag when it's built.

Each feature exports its routes, and `backend/src/modules/master/master.routes.ts` combines them. A test fails if that list and the Master manifest disagree about which routes are built or who can use them.

A module's `baseUrl` is the path prefix of its routes on this API, such as `/hr`. Its frontend's address comes from `MODULE_FRONTEND_URLS` in `backend/.env`, and that address must also be in `ALLOWED_ORIGINS`.

## Login and sessions

- **Access token:** a 15-minute HS256 token holding identity only. It's sent as `Authorization: Bearer` and kept in the frontend's memory.
- **Refresh token:** kept in an `HttpOnly`, `SameSite=Strict` cookie that only `/auth` routes on the API receive. Only its hash is stored. It's replaced on every refresh.
- **Session limits:** a session ends after 7 days without use, and after 30 days regardless. `backend/.env` sets these.
- **Two open tabs:** a just-replaced token keeps working for 10 seconds, so tabs refreshing together don't end the session.
- **Stolen tokens:** an older token used after that ends the whole session and writes `auth.session_token_reused` to the activity log.
- **Origin check:** login, refresh and logout refuse any origin not in `ALLOWED_ORIGINS`, and any request with no `Origin` header. Postman requests set the header themselves.
- **Logout:** `/auth/logout` is `public` because it works from the refresh cookie alone, so someone with an expired access token can still sign out.
- **Rate limit:** failed logins and failed password changes are limited per address, in the memory of each API instance. Multiple instances need a shared store, which isn't built yet.
- **Passwords:** a new password needs at least 12 characters. Changing it ends the person's other sessions.

## Access checks

Each route declares its `access` in its feature's route file, and `registerRoutes` attaches the matching middleware, so a protected route can't go live without its checks:

| `access` | Checks on every call |
|---|---|
| `public` | None. Login, refresh and logout add the origin check themselves. |
| `signed` | Access token, session, active account, and no temporary password waiting to be changed |
| `private` | The same, plus the `permission` or one of the `anyPermission` values the route names |

- **Permissions** are read from the database on each call, so a role change applies on the person's next request, even with a token they already hold. `modules/master/access/permissions.ts` combines the role template with special privileges, and the widest scope wins.
- **Special privilege scope:** `team` on a resource marked `scoped` in its manifest, and `all` otherwise.
- **Rules that depend on the data** being changed, such as "nobody changes their own access", belong in services, because middleware can't see that data.
- **Temporary passwords:** while `mustChangePassword` is set, only `GET /auth/me`, `POST /auth/change-password` and logout work.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Postman

The API requests and their tests are saved in `postman/`. That folder is ignored by git, so it only exists on machines where it has been added by hand, and `npm run test:postman` needs it. Update the collection whenever a route changes. If the folder is there, `npm test` fails when a route has no request in it. If it isn't, that check is skipped. Write route parameters as variables, so `/users/:id` is `{{baseUrl}}/users/{{userId}}`.

**In Postman:**
1. Choose **Import** and select both files in `postman/`.
2. Choose **TwinTrack Local** in the environment menu at the top right.
3. Start the backend with `npm run dev:backend`.
4. Send one request, or run the whole **TwinTrack Master API** collection to see its tests.

**From the terminal:** `npm run test:postman` runs the same collection. It starts its own copy of the API, so the dev server doesn't need to be running. MongoDB does.
