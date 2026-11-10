// The home view: sign in as one person, see what they can do, and change someone's access if they're allowed to.
import { describeFailure, escapeHtml, logIn, logOut, send, signedInEmail } from './api.js';

const CHANGE_REASON = 'Testing from the test page';
const DEFAULT_TARGET_EMAIL = 'karim@twintrack.test';

const state = {
  accounts: [],
  routes: [],
  testPassword: '',
  loginEmail: '',
  loginPassword: '',
  loginError: '',
  me: null,
  changeResult: null,
  change: { target: DEFAULT_TARGET_EMAIL, module: '', action: '' },
  setEdit: { module: 'hr', set: 'manager' },
  setResult: null,
};

export function setAccountData(accounts, routes, testPassword) {
  state.accounts = accounts;
  state.routes = routes;
  state.testPassword = testPassword;
}

function fillInAccount(email) {
  state.loginEmail = email;
  state.loginPassword = email ? state.testPassword : '';
  state.loginError = '';
}

const exampleOf = (route) => route.scenarios.find((scenario) => scenario.kind === 'success')?.request;
const readRoutes = () => state.routes.filter((route) => route.method === 'GET' && route.access !== 'Public' && exampleOf(route)?.as);
const nameOf = (email) => state.accounts.find((account) => account.email === email)?.name ?? email;
const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

function renderSignIn(view) {
  const rows = state.accounts.map((account) => `<tr>
      <td><b>${escapeHtml(account.name)}</b><span class="request">${escapeHtml(account.email)}</span></td>
      <td>${escapeHtml(account.access)}</td>
      <td>${escapeHtml(account.canDo)}</td>
      <td><button class="chip" type="button" data-use="${escapeHtml(account.email)}">Use</button></td>
    </tr>`).join('');
  view.innerHTML = `
    <div><h2>Sign in</h2></div>
    <form class="card" id="login-form">
      <div class="form">
        <label for="login-email">Email<input id="login-email" type="email" value="${escapeHtml(state.loginEmail)}" autocomplete="off" required></label>
        <label for="login-password">Password<input id="login-password" type="password" value="${escapeHtml(state.loginPassword)}" autocomplete="off" required></label>
      </div>
      ${state.loginError ? `<p class="outcome bad">${escapeHtml(state.loginError)}</p>` : ''}
      <div><button class="run" id="login-submit" type="submit">Sign in</button></div>
    </form>
    <div class="card">
      <h3>Test accounts</h3>
      <p class="small muted">Select <b>Use</b> to fill in that person's email and password, then select <b>Sign in</b>.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Person</th><th>Access</th><th>What they can do</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  document.getElementById(state.loginEmail ? 'login-submit' : 'login-email').focus();
}

function permissionsHtml(modules) {
  if (modules.length === 0) return '<p class="small">You have no access to any module.</p>';
  const describeSource = ({ profileName, permissionSets }) =>
    [profileName && `profile ${profileName}`, permissionSets.length > 0 && `sets ${permissionSets.join(', ')}`].filter(Boolean).join(', ') || 'no profile or set';
  return modules.map((module) => `<p class="small"><b>${escapeHtml(module.name)}</b> (${escapeHtml(describeSource(module))}): ${escapeHtml(Object.keys(module.permissions).join(', ') || 'nothing')}</p>`).join('');
}

function routesHtml(routeStatuses) {
  const rows = readRoutes().map((route) => {
    const status = routeStatuses.get(route.id);
    return `<tr><td><code>${escapeHtml(route.id)}</code></td><td>${status < 400 ? '<span class="outcome good">Allowed</span>' : '<span class="outcome refused">Refused</span>'}</td><td>${status}</td></tr>`;
  });
  return `<div class="table-wrap"><table><thead><tr><th>Route</th><th>Result</th><th>Status</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function changeCard() {
  const changeableModules = state.me.options.filter((module) => module.canChange);
  if (changeableModules.length === 0) return '<div class="card"><h3>Change someone\'s access</h3><p class="small">You can\'t change anyone\'s access.</p></div>';

  const { target, action } = state.change;
  const chosenModule = changeableModules.find((module) => module.key === state.change.module) ?? changeableModules[0];
  const people = state.accounts.map((account) => option(account.email, `${account.name}: ${account.access}`, target)).join('');
  const actions = [
    ...chosenModule.permissionSets.map((permissionSet) => option(`give:${permissionSet.key}`, `Give permission set: ${permissionSet.name}`, action)),
    option('clear:', 'Take away every permission set', action),
  ];
  const routesNote = chosenModule.key === 'master' ? '' : `<p class="small muted">${escapeHtml(chosenModule.name)} routes aren't built yet, so this change shows in the person's permissions, but no route uses it. Choose Master to see routes open and close.</p>`;
  return `<div class="card">
    <h3>Change someone's access</h3>
    <p class="small muted">This really changes the shared test data.</p>
    <div class="form">
      <label for="change-target">Person<select id="change-target" data-change="target">${people}</select></label>
      <label for="change-module">Module<select id="change-module" data-change="module">${changeableModules.map((module) => option(module.key, module.name, chosenModule.key)).join('')}</select></label>
      <label for="change-action">Change<select id="change-action" data-change="action">${actions.join('')}</select></label>
    </div>
    ${routesNote}
    <div><button class="run" data-apply="true">Save the change</button></div>
    ${state.changeResult ?? ''}
  </div>`;
}

const NEW_SET = '';

function resourceRow(resource, permissionSet) {
  const held = (action) => Boolean(permissionSet?.permissions[`${resource.key}.${action}`]);
  const heldAction = resource.actions.find(held);
  const scope = heldAction ? permissionSet.permissions[`${resource.key}.${heldAction}`] : 'own';
  const boxes = resource.actions.map((action) => {
    const id = `grant-${resource.key}-${action}`;
    return `<label class="check" for="${escapeHtml(id)}"><input type="checkbox" id="${escapeHtml(id)}" data-resource="${escapeHtml(resource.key)}" data-action-name="${escapeHtml(action)}"${held(action) ? ' checked' : ''}> ${escapeHtml(action)}</label>`;
  }).join('');
  const scopes = resource.scoped
    ? `<select id="scope-${escapeHtml(resource.key)}" aria-label="${escapeHtml(resource.label)} reach">${['own', 'team', 'all'].map((value) => option(value, value, scope)).join('')}</select>`
    : '<span class="muted small">Everyone</span>';
  return `<tr><td>${escapeHtml(resource.label)}</td><td><div class="checks">${boxes}</div></td><td>${scopes}</td></tr>`;
}

function permissionSetEditorCard() {
  const { ruleModules } = state.me;
  if (!ruleModules || ruleModules.length === 0) return '';
  const chosenModule = ruleModules.find((module) => module.key === state.setEdit.module) ?? ruleModules[0];
  const permissionSet = chosenModule.permissionSets.find((candidate) => candidate.key === state.setEdit.set);
  const setOptions = [
    ...chosenModule.permissionSets.map((candidate) => option(candidate.key, candidate.name, permissionSet?.key)),
    option(NEW_SET, 'Add a new permission set', permissionSet?.key ?? NEW_SET),
  ].join('');
  return `<div class="card">
    <h3>Edit a permission set</h3>
    <p class="small muted">This changes what everyone holding the set can do on their next request, in the shared test data.</p>
    <div class="form">
      <label for="set-module">Module<select id="set-module" data-set-edit="module">${ruleModules.map((module) => option(module.key, module.name, chosenModule.key)).join('')}</select></label>
      <label for="set-choice">Permission set<select id="set-choice" data-set-edit="set">${setOptions}</select></label>
      <label for="set-name">Name<input id="set-name" value="${escapeHtml(permissionSet?.name ?? '')}" autocomplete="off"></label>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Resource</th><th>Permissions</th><th>Reach</th></tr></thead>
      <tbody>${chosenModule.resources.map((resource) => resourceRow(resource, permissionSet)).join('')}</tbody>
    </table></div>
    <div class="buttons"><button class="run" data-save-set="true">${permissionSet ? 'Save permission set' : 'Add permission set'}</button>${permissionSet ? '<button class="chip" data-remove-set="true">Remove permission set</button>' : ''}</div>
    ${state.setResult ?? ''}
  </div>`;
}

function renderSignedIn(view) {
  const { profile, modules, routeStatuses } = state.me;
  view.innerHTML = `
    <div class="heading-row"><h2>Signed in as ${escapeHtml(profile.name)}</h2><button class="chip" data-sign-out="true">Sign out</button></div>
    <p class="small muted">${escapeHtml(profile.email)}. Choose a route on the left to send a request as this person.</p>
    ${profile.mustChangePassword ? '<div class="card warning"><p class="small">This person has a temporary password, so most routes refuse them. Open <code>POST /auth/change-password</code> on the left to replace it.</p></div>' : ''}
    ${changeCard()}
    ${permissionSetEditorCard()}
    <div class="card"><h3>What you can do</h3>${permissionsHtml(modules)}</div>
    <div class="card"><h3>What you can reach</h3><p class="small muted">Tested just now as ${escapeHtml(profile.name)}, using routes that only read data.</p>${routesHtml(routeStatuses)}</div>`;
}

export function renderAccounts(view) {
  if (signedInEmail() && state.me) renderSignedIn(view);
  else renderSignIn(view);
}

/** The permission set editor only appears for someone the API lets edit sets in at least one module. */
async function loadRuleEditor(asMe) {
  const answer = await asMe('/permission-sets');
  return { ruleModules: answer.status === 200 ? answer.body.modules : null };
}

async function loadMyAccess() {
  const email = signedInEmail();
  const asMe = (path) => send({ method: 'GET', path, as: email });
  const [profile, myModules, options, statuses, ruleEditor] = await Promise.all([
    asMe('/auth/me'),
    asMe('/me/modules'),
    asMe('/users/access-options'),
    Promise.all(readRoutes().map((route) => asMe(exampleOf(route).path))),
    loadRuleEditor(asMe),
  ]);
  const moduleList = myModules.body?.modules ?? [];
  const permissions = await Promise.all(moduleList.map((module) => asMe(`/me/permissions/${module.key}`)));
  state.me = {
    profile: profile.body,
    modules: moduleList.map((module, index) => ({
      name: module.name,
      profileName: module.profileName,
      permissionSets: module.permissionSets,
      permissions: permissions[index].body?.permissions ?? {},
    })),
    options: options.status === 200 ? options.body.modules : [],
    routeStatuses: new Map(readRoutes().map((route, index) => [route.id, statuses[index].status])),
    ...ruleEditor,
  };
  const firstChangeable = state.me.options.find((module) => module.canChange);
  if (firstChangeable) {
    state.change.module = firstChangeable.key;
    state.change.action = firstActionIn(firstChangeable);
  }
}

async function handleLogIn(view) {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  state.loginEmail = email;
  state.loginPassword = password;
  state.loginError = '';
  state.changeResult = null;
  try {
    await logIn(email, password);
    await loadMyAccess();
  } catch (error) {
    state.me = null;
    await logOut();
    state.loginError = describeFailure(error);
  }
  renderAccounts(view);
}

async function signOutAndPrepare(view, nextEmail) {
  await logOut();
  state.me = null;
  state.changeResult = null;
  fillInAccount(nextEmail);
  renderAccounts(view);
}

function changeRequest(targetId, held) {
  const { module: moduleKey, action } = state.change;
  const setKey = action.slice(action.indexOf(':') + 1);
  // The route replaces the list, so giving one keeps the sets the person already holds.
  const permissionSets = setKey ? [...new Set([...(held?.permissionSets ?? []), setKey])] : [];
  return {
    method: 'PUT',
    path: `/users/${targetId}/permission-sets`,
    as: signedInEmail(),
    body: JSON.stringify({ module: moduleKey, permissionSets, reason: CHANGE_REASON }),
  };
}

const firstActionIn = (module) => (module.permissionSets[0] ? `give:${module.permissionSets[0].key}` : 'clear:');

async function applyChange(view) {
  const { target } = state.change;
  const targetAccount = state.accounts.find((account) => account.email === target);
  const moduleField = document.getElementById('change-module');
  const actionField = document.getElementById('change-action');
  state.change.module = moduleField.value;
  state.change.action = actionField.value;
  // The last result would otherwise stay on screen, looking like the answer to this change.
  state.changeResult = null;
  renderAccounts(view);
  try {
    const people = await send({ method: 'GET', path: `/modules/${state.change.module}/people`, as: signedInEmail() });
    const held = people.body?.people?.find((person) => person.id === targetAccount.id);
    const { status, body } = await send(changeRequest(targetAccount.id, held));
    const switchButton = target === signedInEmail() ? '' : `<div><button class="run" data-switch="${escapeHtml(target)}">Sign in as ${escapeHtml(nameOf(target))} to test</button></div>`;
    state.changeResult = status < 400
      ? `<p class="outcome good">Saved. It applies to ${escapeHtml(nameOf(target))} straight away.</p>${switchButton}`
      : `<p class="outcome refused">Refused: ${status} ${escapeHtml(body?.error?.code)}. ${escapeHtml(body?.error?.message)}</p>`;
    if (target === signedInEmail()) await loadMyAccess();
  } catch (error) {
    state.changeResult = `<p class="outcome bad">${escapeHtml(describeFailure(error))}</p>`;
  }
  renderAccounts(view);
}

function grantsFromEditor(moduleKey) {
  const chosenModule = state.me.ruleModules.find((module) => module.key === moduleKey);
  const grants = {};
  for (const resource of chosenModule.resources) {
    const actions = [...document.querySelectorAll('input[data-resource]')]
      .filter((box) => box.dataset.resource === resource.key && box.checked)
      .map((box) => box.dataset.actionName);
    if (actions.length === 0) continue;
    grants[resource.key] = { actions, ...(resource.scoped && { scope: document.getElementById(`scope-${resource.key}`).value }) };
  }
  return grants;
}

const setKeyFrom = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function editOutcome(status, body, savedText) {
  return status < 400
    ? `<p class="outcome good">${escapeHtml(savedText)}</p>`
    : `<p class="outcome refused">Refused: ${status} ${escapeHtml(body?.error?.code)}. ${escapeHtml(body?.error?.message)}</p>`;
}

async function savePermissionSet(view) {
  const moduleKey = document.getElementById('set-module').value;
  const chosenSetKey = document.getElementById('set-choice').value;
  const name = document.getElementById('set-name').value.trim();
  const grants = grantsFromEditor(moduleKey);
  const key = chosenSetKey || setKeyFrom(name);
  try {
    const answer = chosenSetKey
      ? await send({ method: 'PATCH', path: `/permission-sets/${moduleKey}/${chosenSetKey}`, as: signedInEmail(), body: JSON.stringify({ name, grants }) })
      : await send({ method: 'POST', path: `/permission-sets/${moduleKey}`, as: signedInEmail(), body: JSON.stringify({ key, name, grants }) });
    state.setResult = editOutcome(answer.status, answer.body, `Saved ${name}. It applies on each person's next request.`);
    if (answer.status < 400) {
      state.setEdit = { module: moduleKey, set: key };
      await loadMyAccess();
    }
  } catch (error) {
    state.setResult = `<p class="outcome bad">${escapeHtml(describeFailure(error))}</p>`;
  }
  renderAccounts(view);
}

async function removePermissionSet(view) {
  const moduleKey = document.getElementById('set-module').value;
  const chosenSetKey = document.getElementById('set-choice').value;
  if (!confirm(`Remove this permission set from the shared test data?\n\n${chosenSetKey}`)) return;
  try {
    const answer = await send({ method: 'DELETE', path: `/permission-sets/${moduleKey}/${chosenSetKey}`, as: signedInEmail() });
    state.setResult = editOutcome(answer.status, answer.body, `Removed ${chosenSetKey}.`);
    if (answer.status < 400) {
      state.setEdit.set = NEW_SET;
      await loadMyAccess();
    }
  } catch (error) {
    state.setResult = `<p class="outcome bad">${escapeHtml(describeFailure(error))}</p>`;
  }
  renderAccounts(view);
}

export function handleAccountsClick(view, button) {
  if (button.dataset.saveSet) {
    void savePermissionSet(view);
    return;
  }
  if (button.dataset.removeSet) {
    void removePermissionSet(view);
    return;
  }
  if (button.dataset.use) {
    fillInAccount(button.dataset.use);
    renderAccounts(view);
  } else if (button.dataset.signOut) {
    void signOutAndPrepare(view, '');
  } else if (button.dataset.switch) {
    void signOutAndPrepare(view, button.dataset.switch);
  } else if (button.dataset.apply) {
    void applyChange(view);
  }
}

export function handleAccountsSubmit(view, event) {
  if (event.target.id !== 'login-form') return;
  event.preventDefault();
  void handleLogIn(view);
}

export function handleAccountsChange(view, field) {
  if (field.dataset.setEdit) {
    state.setEdit[field.dataset.setEdit] = field.value;
    if (field.dataset.setEdit === 'module') state.setEdit.set = NEW_SET;
    state.setResult = null;
    renderAccounts(view);
    return;
  }
  state.change[field.dataset.change] = field.value;
  if (field.dataset.change === 'module') {
    const chosenModule = state.me.options.find((module) => module.key === field.value);
    state.change.action = firstActionIn(chosenModule);
    renderAccounts(view);
  }
}
