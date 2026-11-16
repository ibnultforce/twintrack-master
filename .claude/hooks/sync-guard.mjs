/**
 * Claude Code hooks that make the twintrack-sync skill run on every backend change.
 *
 *   node sync-guard.mjs session-start   notes when the session started and reminds Claude of the skill
 *   node sync-guard.mjs post-tool       after an edit or shell command: on the first backend change, tells Claude to use the skill
 *   node sync-guard.mjs stop            stops Claude finishing once if it changed the backend but nothing that describes it
 *
 * Changes are found by modification time since the session started, so edits made through the shell count too.
 * Claude Code passes the hook's input as JSON on stdin. Each session's state is kept in the OS temp folder.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MASTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL_HINT = 'use the twintrack-sync skill (twintrack-master/.claude/skills/twintrack-sync/SKILL.md)';
/** Backend source whose changes can change the API contract. */
const BACKEND_FOLDERS = ['backend/src'];
/** Everything that describes the backend. A change to any of them shows the sync was at least started. */
const DESCRIBING_FOLDERS = ['manifests', 'docs', 'postman', 'backend/test-page', 'module-packs', 'design'];
const SKIPPED_FOLDERS = new Set(['node_modules', '.next', 'dist']);

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function statePath(sessionId) {
  return join(tmpdir(), `twintrack-sync-${String(sessionId ?? 'unknown').replace(/[^\w-]/g, '')}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeState(sessionId, state) {
  writeFileSync(statePath(sessionId), JSON.stringify(state));
}

/** A resumed session keeps the time it first started, so earlier changes still count. */
function sessionState(sessionId) {
  const state = readState(sessionId);
  if (state) return state;
  const started = { startedAt: Date.now(), reminded: false };
  writeState(sessionId, started);
  return started;
}

/** Files under the folders changed since the given time, as paths relative to twintrack-master. */
function changedSince(folders, since) {
  const changed = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (SKIPPED_FOLDERS.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (statSync(path).mtimeMs > since) changed.push(relative(MASTER_ROOT, path).replaceAll('\\', '/'));
    }
  };
  for (const folder of folders.map((name) => join(MASTER_ROOT, name)).filter((path) => existsSync(path))) visit(folder);
  return changed;
}

function addContext(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

const command = process.argv[2];
const input = readInput();

if (command === 'session-start') {
  sessionState(input.session_id);
  addContext('SessionStart', `TwinTrack: whenever you change anything in twintrack-master/backend (a module, route, resource, action, field or model), ${SKILL_HINT} before you finish, so the manifest, permissions, Postman, /try scenarios, docs and frontend packs stay in step.`);
} else if (command === 'post-tool') {
  const state = sessionState(input.session_id);
  if (!state.reminded) {
    const backendChanges = changedSince(BACKEND_FOLDERS, state.startedAt);
    if (backendChanges.length > 0) {
      writeState(input.session_id, { ...state, reminded: true });
      addContext('PostToolUse', `You changed backend source (${backendChanges.slice(0, 3).join(', ')}). When the code is done, ${SKILL_HINT}.`);
    }
  }
} else if (command === 'stop') {
  // stop_hook_active means Claude is already continuing because of this hook: never block twice.
  if (!input.stop_hook_active) {
    const { startedAt } = sessionState(input.session_id);
    const backendChanges = changedSince(BACKEND_FOLDERS, startedAt);
    if (backendChanges.length > 0 && changedSince(DESCRIBING_FOLDERS, startedAt).length === 0) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `Backend source changed this session (${backendChanges.slice(0, 5).join(', ')}), but no manifest, docs, Postman, /try scenario or module pack did. Now ${SKILL_HINT}. If the change alters no contract (an internal refactor or fix), say so in your summary and finish.`,
      }));
    }
  }
}
