// The home view: sign in as one person, see what they can do, and change someone's access if they're allowed to.
import { describeFailure, escapeHtml, logIn, logOut, send, signedInEmail } from './api.js';

const DEFAULT_TARGET_EMAIL = 'karim@twintrack.test';
const NO_PROFILE = '';

const state = {
  accounts: [],
  routes: [],
  testPassword: '',
  loginEmail: '',
  loginPassword: '',
  loginError: '',
  me: null,
  changeResult: null,
  change: { target: DEFAULT_TARGET_EMAIL, profileId: NO_PROFILE },
  profileEdit: { profileId: NO_PROFILE, module: 'hr' },
  profileResult: null,
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
  const describeSource = ({ profileName }) => (profileName ? `profile ${profileName}` : 'no profile');
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
  const { canGiveProfiles, profiles } = state.me;
  if (!canGiveProfiles || !profiles) return '<div class="card"><h3>Change someone\'s access</h3><p class="small">You can\'t give anyone a profile. That needs userProfile.update, and accessProfile.read to list the profiles.</p></div>';

  const { target, profileId } = state.change;
  const people = state.accounts.map((account) => option(account.email, `${account.name}: ${account.access}`, target)).join('');
  const choices = [option(NO_PROFILE, 'No profile', profileId), ...profiles.map((profile) => option(profile.id, profile.name, profileId))].join('');
  return `<div class="card">
    <h3>Change someone's access</h3>
    <p class="small muted">This really changes the shared test data. A profile applies in every module, and you can only give one within your own access.</p>
    <div class="form">
      <label for="change-target">Person<select id="change-target" data-change="target">${people}</select></label>
      <label for="change-profile">Profile<select id="change-profile" data-change="profileId">${choices}</select></label>
    </div>
    <div><button class="run" data-apply="true">Save the change</button></div>
    ${state.changeResult ?? ''}
  </div>`;
}

function resourceRow(resource, permissions) {
  const held = (action) => Boolean(permissions[`${resource.key}.${action}`]);
  const heldAction = resource.actions.find(held);
  const scope = heldAction ? permissions[`${resource.key}.${heldAction}`] : 'own';
  const boxes = resource.actions.map((action) => {
    const id = `grant-${resource.key}-${action}`;
    return `<label class="check" for="${escapeHtml(id)}"><input type="checkbox" id="${escapeHtml(id)}" data-resource="${escapeHtml(resource.key)}" data-action-name="${escapeHtml(action)}"${held(action) ? ' checked' : ''}> ${escapeHtml(action)}</label>`;
  }).join('');
  const scopes = resource.scoped
    ? `<select id="scope-${escapeHtml(resource.key)}" aria-label="${escapeHtml(resource.label)} reach">${['own', 'team', 'all'].map((value) => option(value, value, scope)).join('')}</select>`
    : '<span class="muted small">Everyone</span>';
  return `<tr><td>${escapeHtml(resource.label)}</td><td><div class="checks">${boxes}</div></td><td>${scopes}</td></tr>`;
}

/** Edits one module's part of a profile. Only shown to someone who can list profiles and modules. */
function profileEditorCard() {
  const { profiles, ruleModules } = state.me;
  if (!profiles || !ruleModules || ruleModules.length === 0) return '';
  const chosenModule = ruleModules.find((module) => module.key === state.profileEdit.module) ?? ruleModules[0];
  const profile = profiles.find((candidate) => candidate.id === state.profileEdit.profileId);
  const permissions = profile?.modules.find((part) => part.key === chosenModule.key)?.permissions ?? {};
  const profileOptions = [option(NO_PROFILE, 'Add a new profile', profile?.id ?? NO_PROFILE), ...profiles.map((candidate) => option(candidate.id, candidate.name, profile?.id))].join('');
  return `<div class="card">
    <h3>Edit a profile</h3>
    <p class="small muted">This changes what everyone holding the profile can do on their next request, in the shared test data. You can only build one within your own access.</p>
    <div class="form">
      <label for="profile-choice">Profile<select id="profile-choice" data-profile-edit="profileId">${profileOptions}</select></label>
      <label for="profile-module">Module<select id="profile-module" data-profile-edit="module">${ruleModules.map((module) => option(module.key, module.name, chosenModule.key)).join('')}</select></label>
      <label for="profile-name">Name<input id="profile-name" value="${escapeHtml(profile?.name ?? '')}" autocomplete="off"></label>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Resource</th><th>Permissions</th><th>Reach</th></tr></thead>
      <tbody>${chosenModule.resources.map((resource) => resourceRow(resource, permissions)).join('')}</tbody>
    </table></div>
    <div class="buttons"><button class="run" data-save-profile="true">${profile ? 'Save profile' : 'Add profile'}</button>${profile ? '<button class="chip" data-remove-profile="true">Remove profile</button>' : ''}</div>
    ${state.profileResult ?? ''}
  </div>`;
}

function renderSignedIn(view) {
  const { profile, modules, routeStatuses } = state.me;
  view.innerHTML = `
    <div class="heading-row"><h2>Signed in as ${escapeHtml(profile.name)}</h2><button class="chip" data-sign-out="true">Sign out</button></div>
    <p class="small muted">${escapeHtml(profile.email)}. Choose a route on the left to send a request as this person.</p>
    ${changeCard()}
    ${profileEditorCard()}
    <div class="card"><h3>What you can do</h3>${permissionsHtml(modules)}</div>
    <div class="card"><h3>What you can reach</h3><p class="small muted">Tested just now as ${escapeHtml(profile.name)}, using routes that only read data.</p>${routesHtml(routeStatuses)}</div>`;
}

export function renderAccounts(view) {
  if (signedInEmail() && state.me) renderSignedIn(view);
  else renderSignIn(view);
}

async function loadMyAccess() {
  const email = signedInEmail();
  const asMe = (path) => send({ method: 'GET', path, as: email });
  const [profile, myModules, masterAccess, profiles, registered, statuses] = await Promise.all([
    asMe('/auth/me'),
    asMe('/me/modules'),
    asMe('/me/permissions/master'),
    asMe('/access-profiles'),
    asMe('/modules'),
    Promise.all(readRoutes().map((route) => asMe(exampleOf(route).path))),
  ]);
  const moduleList = myModules.body?.modules ?? [];
  const permissions = await Promise.all(moduleList.map((module) => asMe(`/me/permissions/${module.key}`)));
  state.me = {
    profile: profile.body,
    modules: moduleList.map((module, index) => ({
      name: module.name,
      profileName: module.profileName,
      permissions: permissions[index].body?.permissions ?? {},
    })),
    canGiveProfiles: Boolean(profile.body?.superAdmin || masterAccess.body?.permissions?.['userProfile.update']),
    profiles: profiles.status === 200 ? profiles.body.profiles : null,
    ruleModules: registered.status === 200 ? registered.body.modules : null,
    routeStatuses: new Map(readRoutes().map((route, index) => [route.id, statuses[index].status])),
  };
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

async function applyChange(view) {
  const { target } = state.change;
  const targetAccount = state.accounts.find((account) => account.email === target);
  state.change.profileId = document.getElementById('change-profile').value;
  // The last result would otherwise stay on screen, looking like the answer to this change.
  state.changeResult = null;
  renderAccounts(view);
  try {
    const { status, body } = await send({
      method: 'PUT',
      path: `/users/${targetAccount.id}/profile`,
      as: signedInEmail(),
      body: JSON.stringify({ profileId: state.change.profileId || null }),
    });
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

function editOutcome(status, body, savedText) {
  return status < 400
    ? `<p class="outcome good">${escapeHtml(savedText)}</p>`
    : `<p class="outcome refused">Refused: ${status} ${escapeHtml(body?.error?.code)}. ${escapeHtml(body?.error?.message)}</p>`;
}

async function saveProfile(view) {
  const moduleKey = document.getElementById('profile-module').value;
  const chosenId = document.getElementById('profile-choice').value;
  const name = document.getElementById('profile-name').value.trim();
  const moduleGrants = grantsFromEditor(moduleKey);
  const existing = state.me.profiles.find((profile) => profile.id === chosenId);
  // A profile holds every module, so an edit keeps the other modules' parts as they are.
  const grants = { ...(existing?.grants ?? {}) };
  if (Object.keys(moduleGrants).length > 0) grants[moduleKey] = moduleGrants;
  else delete grants[moduleKey];
  try {
    const answer = existing
      ? await send({ method: 'PATCH', path: `/access-profiles/${existing.id}`, as: signedInEmail(), body: JSON.stringify({ name, grants }) })
      : await send({ method: 'POST', path: '/access-profiles', as: signedInEmail(), body: JSON.stringify({ name, grants }) });
    state.profileResult = editOutcome(answer.status, answer.body, `Saved ${name}. It applies on each holder's next request.`);
    if (answer.status < 400) {
      state.profileEdit = { profileId: answer.body.id, module: moduleKey };
      await loadMyAccess();
    }
  } catch (error) {
    state.profileResult = `<p class="outcome bad">${escapeHtml(describeFailure(error))}</p>`;
  }
  renderAccounts(view);
}

async function removeProfile(view) {
  const chosenId = document.getElementById('profile-choice').value;
  if (!confirm(`Remove this profile from the shared test data?\n\n${chosenId}`)) return;
  try {
    const answer = await send({ method: 'DELETE', path: `/access-profiles/${chosenId}`, as: signedInEmail() });
    state.profileResult = editOutcome(answer.status, answer.body, `Removed ${chosenId}.`);
    if (answer.status < 400) {
      state.profileEdit.profileId = NO_PROFILE;
      await loadMyAccess();
    }
  } catch (error) {
    state.profileResult = `<p class="outcome bad">${escapeHtml(describeFailure(error))}</p>`;
  }
  renderAccounts(view);
}

export function handleAccountsClick(view, button) {
  if (button.dataset.saveProfile) {
    void saveProfile(view);
    return;
  }
  if (button.dataset.removeProfile) {
    void removeProfile(view);
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
  if (field.dataset.profileEdit) {
    state.profileEdit[field.dataset.profileEdit] = field.value;
    state.profileResult = null;
    renderAccounts(view);
    return;
  }
  if (field.dataset.change) state.change[field.dataset.change] = field.value;
}
