/**
 * The text of the super admin's "Claude Code on the web" side panel: how to work on this repo
 * from any computer, and how to let someone else work on it.
 * Kept as data so the wording can change without touching the panel.
 */

export const REPOSITORY_URL = 'https://github.com/ibnultforce/twintrack-master';
export const REPOSITORY_COLLABORATORS_URL = `${REPOSITORY_URL}/settings/access`;
export const CLAUDE_CODE_WEB_URL = 'https://claude.ai/code';

/** Shown as a pill beside the step. Steps without one are ordinary steps to follow. */
export type StepImportance = 'important' | 'optional';

export type GuideStep = {
  title: string;
  text: string;
  importance?: StepImportance;
  /** Text to copy, such as a prompt for Claude Code or the hosts to allow, shown with a Copy button. */
  prompt?: string;
};

export type GuideSection = {
  title: string;
  steps: GuideStep[];
};

export const CLAUDE_WEB_GUIDE: GuideSection[] = [
  {
    title: 'Work on it yourself',
    steps: [
      {
        title: 'Start a session',
        text: 'At claude.ai/code, connect GitHub once, then start a session on twintrack-master, branch main. Nothing installs on your computer.',
      },
      {
        title: 'Allow the network',
        importance: 'important',
        text: 'In the session\'s title bar, open the cloud environment menu, then Edit. Under Network access pick Limited, keep "Allow package managers" ticked (it covers npm), and add these under Allowed domains, for the test database and the demo:',
        prompt: ['fastdl.mongodb.org', 'demo.twintrack.work'].join('\n'),
      },
      {
        title: 'Ask for what you want',
        text: 'The repo\'s CLAUDE.md tells the session how to build, test and push, so plain requests work. To check the setup first, paste:',
        importance: 'optional',
        prompt: 'Set up this repo and run its checks. Report each command with its real result.',
      },
      {
        title: 'Check the result',
        text: 'Each push to main runs "Deploy demo" on GitHub: the full tests, then demo.twintrack.work. Only a green run means it\'s live.',
        importance: 'important',
      },
      {
        title: 'Get screenshots',
        text: 'To see the demo without opening it, paste:',
        importance: 'optional',
        prompt: 'Screenshot the main screens of demo.twintrack.work with Playwright, signed in as a seed user from seed/users.json (password demo1234). Commit them to screenshots/<today\'s date>/ with a README and give me the GitHub link.',
      },
    ],
  },
  {
    title: 'Let someone else work on it',
    steps: [
      {
        title: 'Give them the repo',
        importance: 'important',
        text: 'On GitHub, invite them as a collaborator on twintrack-master (Settings, Collaborators). Write access lets them push.',
      },
      {
        title: 'They start their own session',
        text: 'With their own Claude account, they follow "Work on it yourself" above. They need a plan that includes Claude Code.',
      },
      {
        title: 'Know that main deploys',
        importance: 'important',
        text: 'Anything they push to main goes live on the demo. To review first, ask them to use a branch and a pull request, and merge it yourself.',
      },
      {
        title: 'Testing only?',
        importance: 'optional',
        text: 'Someone who only tests needs no GitHub: add them on People, give them a profile, and they get an email to set a password for the demo.',
      },
    ],
  },
];
