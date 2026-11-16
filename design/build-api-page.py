"""Builds master-api-scenarios.html from the backend's test-page scenarios, test accounts and test permission sets.

Run from this folder after changing scenarios.json, once api-samples.json has been recorded (see SAMPLES):  python build-api-page.py
Then republish the page to its artifact URL.
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent
TEMPLATE = HERE / 'api-page-template.html'
OUTPUT = HERE / 'master-api-scenarios.html'
# Written by the replay test:  cd ../backend && API_SAMPLES_FILE=../design/api-samples.json npx vitest run tests/test-page.test.ts
SAMPLES = HERE / 'api-samples.json'
SAMPLE_LIST_LENGTH = 2

# Update these after each run of npm test and npm run test:postman.
CHECKS = {'tests': 1383, 'postmanRequests': 409, 'postmanAssertions': 665, 'date': '13 November 2026'}

MODULES = [
    {'key': 'master', 'name': 'Master', 'prefix': None,
     'about': 'Sign-in, your own account, people, the org tree, profiles and giving them, modules, custom objects and the activity log.'},
    {'key': 'hr', 'name': 'HR', 'prefix': '/hr',
     'about': 'Salaries, with scope, approval, a recycle bin, history and sharing. Every salary field has its own access level (hidden, read, create only or edit), and amount is protected.'},
    {'key': 'projects', 'name': 'Project management', 'prefix': '/projects',
     'about': 'Projects and members, and tasks from start through QA to approval, with comments, links, history and per-field access.'},
    {'key': 'test', 'name': 'Test', 'prefix': '/test',
     'about': 'One route for checking a module end to end: it answers a caller who holds its permission.'},
]


def read_json(relative_path):
    return json.loads((REPO / relative_path).read_text(encoding='utf-8'))


def module_of(path):
    for module in MODULES:
        prefix = module['prefix']
        if prefix and (path == prefix or path.startswith(prefix + '/')):
            return module['key']
    return 'master'


def describe_step(step):
    who = f" as {step['as'].split('@')[0]}" if step.get('as') else ''
    return f"{step['method']} {step['path']}{who}"


def scenario_row(scenario):
    request = scenario['request']
    return [
        1 if scenario['kind'] == 'success' else 0,
        scenario['title'],
        scenario['expected'],
        scenario.get('code', ''),
        f"{request['method']} {request['path']}",
        request.get('as', ''),
        [describe_step(step) for step in scenario.get('setup', [])],
        1 if request.get('origin') else 0,
    ]


def main():
    scenarios = read_json('backend/test-page/scenarios.json')
    accounts = read_json('backend/test-page/accounts.json')
    fixture = read_json('backend/tests/fixtures/test-access.json')
    samples = json.loads(SAMPLES.read_text(encoding='utf-8'))

    data = {module['key']: {'groups': []} for module in MODULES}
    for group in scenarios['groups']:
        routes_by_module = {}
        for route in group['routes']:
            routes_by_module.setdefault(module_of(route['path']), []).append({
                'id': route['id'], 'method': route['method'], 'path': route['path'],
                'purpose': route.get('purpose', ''), 'input': route.get('input', ''), 'access': route.get('access', ''),
                'rows': [scenario_row(scenario) for scenario in route['scenarios']],
                'sample': samples.get(route['id']),
            })
        for key, routes in routes_by_module.items():
            data[key]['groups'].append({'name': group['name'], 'routes': routes})

    for module in MODULES:
        routes = [route for group in data[module['key']]['groups'] for route in group['routes']]
        module['routes'] = len(routes)
        module['scenarios'] = sum(len(route['rows']) for route in routes)

    # The live test page starts from the product seed, where only the super admin has access.
    # The automated replay gives people the test profiles, so the page shows both.
    profiles = {profile['id']: profile for profile in fixture['profiles']}
    people = []
    for account in accounts['accounts']:
        profile = profiles.get(fixture['people'].get(account['id'], ''))
        people.append({
            'name': account['name'], 'email': account['email'], 'live': account['access'],
            'tests': {m['key']: [profile['name']] if profile and m['key'] in profile['grants'] else [] for m in MODULES},
        })

    payload = {'modules': MODULES, 'data': data, 'people': people, 'password': accounts['testPassword'], 'checks': CHECKS, 'sampleListLength': SAMPLE_LIST_LENGTH}
    page = TEMPLATE.read_text(encoding='utf-8').replace('__DATA__', json.dumps(payload, ensure_ascii=False).replace('</', '<\\/'))
    OUTPUT.write_text(page, encoding='utf-8')
    print({m['key']: f"{m['routes']} routes, {m['scenarios']} scenarios" for m in MODULES})


if __name__ == '__main__':
    main()
