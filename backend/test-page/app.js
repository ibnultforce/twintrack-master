// Runs the scenarios in scenarios.json from a browser. A test replays the same file against the API, so it can't drift.
import { handleAccountsChange, handleAccountsClick, handleAccountsSubmit, renderAccounts, setAccountData } from './accounts.js';
import { describeFailure, escapeHtml, personName, send, signedInEmail, signIn } from './api.js';

// Used for scenarios that need a refresh cookie and don't depend on who holds it.
const COOKIE_HOLDER_EMAIL = 'rahim@twintrack.test';

const list = document.getElementById('list');
const view = document.getElementById('view');
const search = document.getElementById('search');
const home = document.getElementById('home');
const who = document.getElementById('who');

const [{ groups }, { accounts, testPassword }] = await Promise.all([
  (await fetch('scenarios.json')).json(),
  (await fetch('accounts.json')).json(),
]);
const routes = groups.flatMap((group) => group.routes);
setAccountData(accounts, routes, testPassword);
const results = new Map();
const tryForms = new Map();
let filter = 'all';
let resultsOwner = null;

const slugOf = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const currentRoute = () => routes.find((route) => slugOf(route.id) === location.hash.slice(1));
const hasBodyField = (route) => route.method !== 'GET' && route.method !== 'DELETE';

function renderList() {
  const query = search.value.trim().toLowerCase();
  const current = currentRoute();
  const html = groups
    .map((group) => {
      const matches = group.routes.filter((route) => {
        const text = [route.id, route.purpose, ...route.scenarios.flatMap((scenario) => [scenario.title, scenario.code])].join(' ').toLowerCase();
        return text.includes(query);
      });
      if (matches.length === 0) return '';
      const items = matches.map((route) =>
        `<a class="item${route === current ? ' current' : ''}" href="#${slugOf(route.id)}"><span class="method ${route.method.toLowerCase()}">${route.method}</span><code>${escapeHtml(route.path)}</code></a>`,
      );
      return `<h3>${escapeHtml(group.name)}</h3>${items.join('')}`;
    })
    .join('');
  list.innerHTML = html || '<p class="none">No route matches that search.</p>';
  home.className = `home${current ? '' : ' current'}`;
  home.textContent = signedInEmail() ? 'My access' : 'Sign in';
  who.textContent = signedInEmail() ? `Signed in as ${personName(signedInEmail())}` : 'Not signed in';
}

function resultHtml(result) {
  if (!result) return '';
  if (result.error) return `<p class="outcome bad">${escapeHtml(result.error)}</p>`;
  if (!result.expectedText) return `<p class="outcome ${result.status < 400 ? 'good' : 'refused'}">Answered ${result.status}</p><pre>${escapeHtml(result.shown)}</pre>`;
  const outcome = result.isExpected
    ? `<p class="outcome good">As expected: ${result.status}</p>`
    : `<p class="outcome bad">Different from the recorded result: got ${result.status}, expected ${escapeHtml(result.expectedText)}</p>`;
  return `${outcome}<pre>${escapeHtml(result.shown)}</pre>`;
}

function tryFormFor(route) {
  if (!tryForms.has(route.id)) {
    const example = route.scenarios.find((scenario) => scenario.kind === 'success')?.request ?? route.scenarios[0].request;
    tryForms.set(route.id, { path: example.path, body: example.body ?? '' });
  }
  return tryForms.get(route.id);
}

function tryCard(route) {
  if (route.method === 'ANY') return '';
  const form = tryFormFor(route);
  const sender = signedInEmail() ? personName(signedInEmail()) : 'someone who is not signed in';
  return `<div class="card">
    <h3>Send as ${escapeHtml(sender)}</h3>
    <label for="try-path">Address<input id="try-path" data-try="path" value="${escapeHtml(form.path)}" spellcheck="false"></label>
    ${hasBodyField(route) ? `<label for="try-body">Body<textarea id="try-body" data-try="body" rows="4" spellcheck="false">${escapeHtml(form.body)}</textarea></label>` : ''}
    <div><button class="run" data-send="true">Send</button></div>
    ${resultHtml(results.get(`${route.id}:try`))}
  </div>`;
}

function renderRoute(route) {
  const rows = route.scenarios
    .map((scenario, index) => {
      if (filter !== 'all' && scenario.kind !== filter) return '';
      const { request } = scenario;
      const tags = [
        scenario.changesData ? '<span class="tag warn">Changes data</span>' : '',
        request.as ? `<span class="tag">As ${escapeHtml(personName(request.as))}</span>` : '',
        scenario.setup?.length ? `<span class="tag">${scenario.setup.length} setup ${scenario.setup.length === 1 ? 'step' : 'steps'} first</span>` : '',
        request.origin ? '<span class="tag">Automated replay only</span>' : '',
      ].join('');
      const result = resultHtml(results.get(`${route.id}:${index}`));
      return `<tr><td>${escapeHtml(scenario.title)}<span class="request">${escapeHtml(`${request.method} ${request.path}`)}</span>${tags}</td>
        <td><code>${scenario.expected}${scenario.code ? ` ${escapeHtml(scenario.code)}` : ''}</code></td>
        <td><button class="run" data-index="${index}">Run</button></td></tr>${result ? `<tr class="result"><td colspan="3">${result}</td></tr>` : ''}`;
    })
    .join('');
  const count = (kind) => route.scenarios.filter((scenario) => scenario.kind === kind).length;
  const chip = (key, label) => `<button class="chip" data-filter="${key}" aria-pressed="${filter === key}">${label}</button>`;
  view.innerHTML = `
    <div><span class="method ${route.method.toLowerCase()}">${route.method}</span> <h2>${escapeHtml(route.path)}</h2></div>
    <p>${escapeHtml(route.purpose)}</p>
    <p class="small muted">${escapeHtml(route.access)}. Input: ${escapeHtml(route.input)}.</p>
    ${tryCard(route)}
    <div class="heading-row"><h3>Ready-made scenarios</h3><div class="chips">${chip('all', `All ${route.scenarios.length}`)}${chip('success', `Success ${count('success')}`)}${chip('fail', `Failure ${count('fail')}`)}</div></div>
    <p class="small muted">Each one uses the person shown on it, not the person you're signed in as. You still need to be signed in, because they use your password.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Scenario</th><th>Expected</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function render() {
  // A result belongs to the person who asked for it, and the next person may not be allowed to see it.
  if (signedInEmail() !== resultsOwner) {
    results.clear();
    tryForms.clear();
    resultsOwner = signedInEmail();
  }
  renderList();
  const route = currentRoute();
  if (route) renderRoute(route);
  else renderAccounts(view);
}

async function sendFromForm(route) {
  const form = tryFormFor(route);
  const key = `${route.id}:try`;
  try {
    const { status, body, text } = await send({
      method: route.method,
      path: form.path,
      as: signedInEmail() ?? undefined,
      body: hasBodyField(route) && form.body.trim() ? form.body : undefined,
      cookie: form.path.startsWith('/auth/'),
    });
    results.set(key, { status, shown: body ? JSON.stringify(body, null, 2) : text });
  } catch (error) {
    results.set(key, { error: error instanceof SetupFailed ? `A setup step failed: ${error.message} Someone may have changed the test data.` : describeFailure(error) });
  }
  render();
}

/** A request a scenario needs first, such as creating the record it reads, didn't work. */
class SetupFailed extends Error {}

async function runScenario(button) {
  const route = currentRoute();
  const index = Number(button.dataset.index);
  const scenario = route.scenarios[index];
  const key = `${route.id}:${index}`;
  const { request } = scenario;
  const setup = scenario.setup ?? [];

  // Browsers set the Origin header themselves, so only the automated replay can send another one.
  if (request.origin) {
    results.set(key, { error: `Browsers won't send Origin: ${request.origin}, so only the automated replay runs this one.` });
    render();
    return;
  }
  if (!signedInEmail() && [request, ...setup].some((step) => step.as || step.cookie || step.body?.includes('YOUR_PASSWORD'))) {
    results.set(key, { error: 'Sign in first, because this scenario uses your password.' });
    render();
    return;
  }
  if ((scenario.changesData || setup.length > 0) && !confirm(`This really changes the shared test data:\n\n${scenario.title}\n\nRun it?`)) return;

  button.disabled = true;
  button.textContent = 'Running';
  try {
    const saved = {};
    const fillIn = (text) => text?.replace(/\{\{(\w+)\}\}/g, (match, name) => saved[name] ?? match);
    const filled = (step) => ({ ...step, path: fillIn(step.path), body: fillIn(step.body), literalToken: fillIn(step.literalToken) });
    for (const step of setup) {
      if (step.cookie) await signIn(COOKIE_HOLDER_EMAIL);
      const answer = await send(filled(step), 200);
      if (answer.status >= 300) throw new SetupFailed(`${step.method} ${step.path} answered ${answer.status}${answer.body?.error ? ` ${answer.body.error.code}` : ''}.`);
      // A field may be nested, such as attachment.id.
      for (const [name, field] of Object.entries(step.save ?? {})) saved[name] = String(field.split('.').reduce((value, key) => value?.[key], answer.body));
    }
    if (request.cookie) await signIn(COOKIE_HOLDER_EMAIL);
    const { status, body, text } = await send(filled(request), scenario.expected);
    results.set(key, {
      status,
      isExpected: status === scenario.expected && (!scenario.code || body?.error?.code === scenario.code),
      expectedText: `${scenario.expected}${scenario.code ? ` ${scenario.code}` : ''}`,
      shown: body ? JSON.stringify(body, null, 2) : text,
    });
  } catch (error) {
    results.set(key, { error: describeFailure(error) });
  }
  render();
}

view.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    render();
  } else if (button.dataset.index !== undefined) {
    void runScenario(button);
  } else if (button.dataset.send) {
    void sendFromForm(currentRoute());
  } else {
    handleAccountsClick(view, button);
  }
});
view.addEventListener('submit', (event) => handleAccountsSubmit(view, event));
view.addEventListener('input', (event) => {
  const field = event.target.dataset.try;
  if (field) tryFormFor(currentRoute())[field] = event.target.value;
});
view.addEventListener('change', (event) => {
  if (event.target.dataset.change || event.target.dataset.setEdit) handleAccountsChange(view, event.target);
});
search.addEventListener('input', renderList);
window.addEventListener('hashchange', () => {
  filter = 'all';
  render();
  view.scrollTop = 0;
});
// Signing in or out happens inside the home view, so the side panel catches up here.
new MutationObserver(() => {
  if (signedInEmail() !== resultsOwner) {
    results.clear();
    tryForms.clear();
    resultsOwner = signedInEmail();
  }
  renderList();
}).observe(view, { childList: true });
render();
