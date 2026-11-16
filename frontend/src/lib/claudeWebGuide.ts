/**
 * The steps in the super admin's "Claude Code on the web" side panel: how to open this repo
 * from any computer, run the checks and get screenshots back to validate.
 * Kept as data so the wording can change without touching the panel.
 */

export const REPOSITORY_URL = 'https://github.com/ibnultforce/twintrack-master';
export const CLAUDE_CODE_WEB_URL = 'https://claude.ai/code';

export type GuideStep = {
  title: string;
  text: string;
  /** Text to paste into Claude Code, shown with a Copy button. */
  prompt?: string;
};

export const CLAUDE_WEB_SETUP_STEPS: GuideStep[] = [
  {
    title: 'Open Claude Code on the web',
    text: 'On any computer, sign in at claude.ai/code. Nothing needs installing: the session runs in a cloud machine with its own copy of the repo.',
  },
  {
    title: 'Connect GitHub and pick the repo',
    text: 'The first time, connect your GitHub account and allow access to twintrack-master. Then choose that repo and the main branch for a new session.',
  },
  {
    title: 'Allow the network it needs',
    text: 'In the environment settings, allow trusted network access (or add registry.npmjs.org, fastdl.mongodb.org and playwright.azureedge.net). npm install, the in-memory MongoDB for tests and the screenshot browser download from these.',
  },
  {
    title: 'Set up and run the checks',
    text: 'Paste this as the first message. The repo\'s CLAUDE.md already tells the session how to work, and its hooks start the twintrack-sync skill.',
    prompt: [
      'Set up this repo and check it works:',
      '1. Run npm install (Node 22+).',
      '2. Run npm run typecheck, npm run lint and npm test.',
      '3. If npm test can\'t start only because the MongoDB download is blocked, run the tests that need no database (tests/routes.test.ts, tests/module-routes.test.ts, tests/postman-coverage.test.ts and the manifest validation tests) and list the ones that didn\'t run.',
      'Report every command with its real result. Don\'t claim anything passed that you didn\'t run.',
    ].join('\n'),
  },
  {
    title: 'Take screenshots to validate',
    text: 'Cloud sessions have no local MongoDB, so the screenshots are taken from the demo site, which runs the code on main. They are committed to the repo so you can open them on GitHub from any computer.',
    prompt: [
      'Take screenshots of the TwinTrack demo so I can validate it:',
      '1. Use Playwright (npx playwright install chromium, then a short script in a temporary folder, not added to package.json).',
      '2. Open https://demo.twintrack.work, sign in with a seed test user from seed/users.json (password demo1234), and capture the sign-in page, Modules, People, Profiles and Org roles at 1440x900.',
      '3. Save them as screenshots/<today\'s date>/<nn>-<screen>.png with a README.md listing each file, the user and what it shows.',
      '4. Commit them and push to main, then give me the GitHub link to the folder.',
      'If a screen fails to load, screenshot what you got and say so in the README.',
    ].join('\n'),
  },
  {
    title: 'Check the results',
    text: 'Open the screenshots folder on GitHub from the link the session gives you. Every push to main also runs the "Deploy demo" GitHub Actions run, which runs the full test suite with MongoDB: a green run is the final check.',
  },
];
