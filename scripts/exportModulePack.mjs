/**
 * Makes the handoff pack for one module's frontend developer: the module's API doc, manifest and Postman requests,
 * plus a filled-in brief from the starter's template. Nothing else from the backend goes in it.
 *
 *   npm run export:module-pack -- <module key> [output folder]
 *
 * The pack goes to ../module-packs/<module key>/ by default. Copy its contents into the frontend's docs/ folder.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MASTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIEF_TEMPLATE = resolve(MASTER_ROOT, '../twintrack-module-starter/docs/MODULE_BRIEF.template.md');
const POSTMAN_COLLECTION = join(MASTER_ROOT, 'postman/twintrack-master.postman_collection.json');
/** Collection variables that hold secrets or local values, emptied so the pack carries none. */
const SECRET_VARIABLE = /token|password|secret|code|verifier|challenge|etag/i;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path) {
  if (!existsSync(path)) fail(`Missing ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function permissionsTable(manifest) {
  const rows = manifest.resources.flatMap((resource) =>
    resource.actions.map((action) => `| \`${resource.key}.${action}\` | ${resource.label ?? resource.key} | ${resource.scoped ? 'own, team or all' : 'yes or no'} |`));
  return ['| Permission | Resource | Scope |', '|---|---|---|', ...rows].join('\n');
}

function routesTable(manifest) {
  const baseUrl = manifest.module.baseUrl ?? `/${manifest.module.key}`;
  const rows = manifest.routes.map((route) => {
    const access = route.access === 'private' ? `\`${route.permission ?? (route.anyPermission ?? []).join('` or `')}\`` : route.access;
    return `| \`${route.method} ${baseUrl}${route.path}\` | ${access} |`;
  });
  return ['| Route | Needs |', '|---|---|', ...rows].join('\n');
}

const ACCOUNTS_PLACEHOLDER = [
  '| Email | Profile | What they should see |',
  '|---|---|---|',
  '| (fill in) | Full access to this module | Everything |',
  '| (fill in) | Read only, own records | Only their own records, no buttons |',
  '| (fill in) | No access to this module | The "No access" page |',
].join('\n');

/** Only this module's Postman folder, with secrets and local values removed from the variables. */
function modulePostman(collection, moduleName, moduleKey) {
  const folder = collection.item.find((item) => item.name === moduleName);
  if (!folder) fail(`The Postman collection has no "${moduleName}" folder.`);
  return {
    info: { ...collection.info, name: `TwinTrack ${moduleName} API`, _postman_id: undefined },
    variable: (collection.variable ?? []).map((variable) => ({
      ...variable,
      value: variable.key === 'baseUrl' ? '' : variable.key === 'moduleKey' ? moduleKey : SECRET_VARIABLE.test(variable.key) ? '' : variable.value,
    })),
    item: [folder],
  };
}

const [moduleKey, outputArgument] = process.argv.slice(2);
if (!moduleKey) fail('Usage: npm run export:module-pack -- <module key> [output folder]');

const manifest = readJson(join(MASTER_ROOT, `manifests/${moduleKey}.manifest.json`));
const apiDocFile = `${moduleKey}.md`;
const apiDocPath = join(MASTER_ROOT, 'docs/api', apiDocFile);
if (!existsSync(apiDocPath)) fail(`Missing ${apiDocPath}`);
if (!existsSync(BRIEF_TEMPLATE)) fail(`Missing the starter's brief template at ${BRIEF_TEMPLATE}`);

const outputDir = resolve(outputArgument ?? join(MASTER_ROOT, '../module-packs', moduleKey));
mkdirSync(join(outputDir, 'api'), { recursive: true });

writeFileSync(join(outputDir, 'api', apiDocFile), readFileSync(apiDocPath, 'utf8'));
// Every module's doc points to this guide for tokens, the error format and errors any route can return.
writeFileSync(join(outputDir, 'api', 'README.md'), readFileSync(join(MASTER_ROOT, 'docs/api/README.md'), 'utf8'));
writeFileSync(join(outputDir, 'api', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outputDir, 'api', 'postman_collection.json'), `${JSON.stringify(modulePostman(readJson(POSTMAN_COLLECTION), manifest.module.name, moduleKey), null, 2)}\n`);

const brief = readFileSync(BRIEF_TEMPLATE, 'utf8')
  .replaceAll('{{MODULE_NAME}}', manifest.module.name)
  .replaceAll('{{MODULE_KEY}}', moduleKey)
  .replaceAll('{{MODULE_DESCRIPTION}}', manifest.module.description ?? '')
  .replaceAll('{{API_DOC_FILE}}', apiDocFile)
  .replaceAll('{{PERMISSIONS}}', permissionsTable(manifest))
  .replaceAll('{{ROUTES}}', routesTable(manifest))
  .replaceAll('{{API_URL}}', '(fill in: the dev server API address)')
  .replaceAll('{{MASTER_URL}}', '(fill in: the dev server sign-in address)')
  .replaceAll('{{APP_URL}}', `(fill in: where this developer opens the app, such as http://${moduleKey}.twintrack.localhost:3400)`)
  .replaceAll('{{ACCOUNTS}}', ACCOUNTS_PLACEHOLDER);
writeFileSync(join(outputDir, 'MODULE_BRIEF.md'), brief);

console.log(`Pack for ${manifest.module.name} written to ${outputDir}`);
console.log('Before sending it: fill in "Screens to build", the dev server addresses and the test accounts in MODULE_BRIEF.md.');
