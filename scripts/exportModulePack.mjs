/**
 * Makes the handoff pack for one module's frontend developer, in the same format for every module:
 *
 *   api/                          the module's API doc, the API guide, its manifest and Postman folder (always rewritten)
 *   design.css                    the starter's globals.css, unchanged (always rewritten)
 *   INSTRUCTIONS.md               from the starter's template, written only when missing; its FILL IN parts are written by hand
 *   DATA_MODEL.md, schema.json    outlines written only when missing, then completed by hand
 *
 *   npm run export:module-pack -- <module key> [output folder]
 *
 * Files written by hand are never overwritten. The pack goes to module-packs/<module key>/ in this repo by default.
 * Copy its contents into the frontend's docs/ folder.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MASTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STARTER_ROOT = resolve(MASTER_ROOT, '../twintrack-module-starter');
const INSTRUCTIONS_TEMPLATE = join(STARTER_ROOT, 'docs/INSTRUCTIONS.template.md');
const SHARED_STYLESHEET = join(STARTER_ROOT, 'src/app/globals.css');
const DEV_APPS_FILE = resolve(MASTER_ROOT, '../twintrack.modules.json');
const POSTMAN_COLLECTION = join(MASTER_ROOT, 'postman/twintrack-master.postman_collection.json');
/** Collection variables that hold secrets or local values, emptied so the pack carries none. */
const SECRET_VARIABLE = /token|password|secret|code|verifier|challenge|etag/i;
const FILL_IN = '<!-- FILL IN -->';

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
  const rows = manifest.routes.filter((route) => !route.planned).map((route) => {
    const access = route.access === 'private' ? `\`${route.permission ?? (route.anyPermission ?? []).join('` or `')}\`` : route.access;
    return `| \`${route.method} ${baseUrl}${route.path}\` | ${access} |`;
  });
  return ['| Route | Needs |', '|---|---|', ...rows].join('\n');
}

/** The dev port from the workspace's app list, so the instructions match `npm run dev`. */
function devPort(moduleKey) {
  if (!existsSync(DEV_APPS_FILE)) return '(fill in)';
  const app = readJson(DEV_APPS_FILE).modules?.find((entry) => entry.name === moduleKey);
  return app?.url?.match(/:(\d+)/)?.[1] ?? '(fill in)';
}

function fieldList(resource) {
  const fields = [...(resource.recordFields ?? []), ...(resource.protectedFields ?? [])];
  return fields.length > 0 ? fields.map((field) => `\`${field}\``).join(', ') : 'none';
}

function dataModelOutline(manifest) {
  const sections = manifest.resources
    .filter((resource) => !resource.custom)
    .map((resource) => [
      `## ${resource.label ?? resource.key}`,
      `${FILL_IN} What this record is, then a table of Field | Type | Always | Field access | Meaning, its allowed values with label and pill tone, and its rules.`,
      `Fields under field security: ${fieldList(resource)}.`,
    ].join('\n\n'));
  return [
    `# ${manifest.module.name}: data model`,
    `What the ${manifest.module.name} API stores and returns. Module key: \`${manifest.module.key}\`. The same model is in \`schema.json\` as JSON Schema.`,
    ...sections,
  ].join('\n\n') + '\n';
}

function schemaOutline(manifest) {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: `TwinTrack ${manifest.module.name} API`, $defs: {} };
}

/** Writes the file only when it doesn't exist, and says whether it did. */
function writeIfMissing(path, content) {
  if (existsSync(path)) return false;
  writeFileSync(path, content);
  return true;
}

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
if (!existsSync(INSTRUCTIONS_TEMPLATE)) fail(`Missing the starter's instructions template at ${INSTRUCTIONS_TEMPLATE}`);
if (!existsSync(SHARED_STYLESHEET)) fail(`Missing the starter's stylesheet at ${SHARED_STYLESHEET}`);

const outputDir = resolve(outputArgument ?? join(MASTER_ROOT, 'module-packs', moduleKey));
mkdirSync(join(outputDir, 'api'), { recursive: true });

writeFileSync(join(outputDir, 'api', apiDocFile), readFileSync(apiDocPath, 'utf8'));
// Every module's doc points to this guide for tokens, the error format and errors any route can return.
writeFileSync(join(outputDir, 'api', 'README.md'), readFileSync(join(MASTER_ROOT, 'docs/api/README.md'), 'utf8'));
writeFileSync(join(outputDir, 'api', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outputDir, 'api', 'postman_collection.json'), `${JSON.stringify(modulePostman(readJson(POSTMAN_COLLECTION), manifest.module.name, moduleKey), null, 2)}\n`);
copyFileSync(SHARED_STYLESHEET, join(outputDir, 'design.css'));

const instructions = readFileSync(INSTRUCTIONS_TEMPLATE, 'utf8')
  .replaceAll('{{MODULE_NAME}}', manifest.module.name)
  .replaceAll('{{MODULE_KEY}}', moduleKey)
  .replaceAll('{{API_DOC_FILE}}', apiDocFile)
  .replaceAll('{{PORT}}', devPort(moduleKey))
  .replaceAll('{{PERMISSIONS}}', permissionsTable(manifest))
  .replaceAll('{{ROUTES}}', routesTable(manifest));
const startedFiles = [
  writeIfMissing(join(outputDir, 'INSTRUCTIONS.md'), instructions) && 'INSTRUCTIONS.md',
  writeIfMissing(join(outputDir, 'DATA_MODEL.md'), dataModelOutline(manifest)) && 'DATA_MODEL.md',
  writeIfMissing(join(outputDir, 'schema.json'), `${JSON.stringify(schemaOutline(manifest), null, 2)}\n`) && 'schema.json',
].filter(Boolean);
// The one-page brief was replaced by INSTRUCTIONS.md.
rmSync(join(outputDir, 'MODULE_BRIEF.md'), { force: true });

console.log(`Pack for ${manifest.module.name} written to ${outputDir}`);
if (startedFiles.length > 0) console.log(`Started ${startedFiles.join(', ')}: write their FILL IN parts before sending the pack.`);
else console.log('Kept INSTRUCTIONS.md, DATA_MODEL.md and schema.json: update them by hand for this change.');
