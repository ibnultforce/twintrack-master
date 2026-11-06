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

`npm run seed` loads the Master and HR modules and the 10-person example team from `seed/`. Everyone's password is `SEED_PASSWORD` from `backend/.env`, or `demo1234` if that isn't set.

- **Safe to re-run:** it updates records by id and creates no duplicates. It resets each person's roles and privileges to what the files say, and keeps passwords already set.
- **All or nothing:** every file is checked first and all problems are listed together. If anything fails, nothing is saved.
- **Development only:** it refuses to run when `NODE_ENV` is `production`.

`seed/manifests/hr.json` is a copy of `access.manifest.json` from the `twintrack-hr` repo, so this repo works on its own. Update both together.

## Backend layout

All module backends live in this repo, each in its own folder under `backend/src/modules/`. Inside a module, each feature has its own folder, split by job:

| File | Job |
|---|---|
| `*.routes.ts` | HTTP only: reads the request and sends the response |
| `*.service.ts` | Rules and workflows |
| `*.repository.ts` | Database queries |

Mongoose schemas are in the module's `models/` folder. Code shared between modules is in `backend/src/lib/`. `backend/src/seed/` loads example data across modules.

## Manifests

`access.manifest.json` lists this module's resources, routes and fixed role templates. A route marked `"planned": true` is designed but not built yet. Remove the flag when it's built.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Postman

The API requests and their tests are saved in `postman/`. That folder is ignored by git, so it only exists on machines where it has been added by hand, and `npm run test:postman` needs it. Update the collection whenever a route changes. If the folder is there, `npm test` fails when a route has no request in it. If it isn't, that check is skipped.

**In Postman:**
1. Choose **Import** and select both files in `postman/`.
2. Choose **TwinTrack Local** in the environment menu at the top right.
3. Start the backend with `npm run dev:backend`.
4. Send one request, or run the whole **TwinTrack Master API** collection to see its tests.

**From the terminal:** `npm run test:postman` runs the same collection. It starts its own copy of the API, so the dev server doesn't need to be running. MongoDB does.
