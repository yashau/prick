/**
 * Capture a screenshot of every screen into `screenshots/`.
 *
 * `mise run screenshots`, with `mise run demo` already serving in another
 * terminal. It drives the demo server rather than `dev`, because `dev` answers
 * 401 to everything: there is no Cloudflare Access in front of a local server
 * and the Worker has no bypass. The demo proxy stands where Access would and
 * attaches a genuine assertion to each request, so a plain Playwright browser
 * is signed in without any cookie surgery.
 *
 * VIEWPORT CAPTURES, NOT `fullPage`. The sidebar and the header are sticky and
 * `h-svh`. A full-page capture paints them once at the top and leaves the rest
 * of the column empty, which looks like a rendering bug in a file somebody will
 * paste into a README. So the viewport is grown to the page's own content
 * height first and the capture is an ordinary one.
 *
 * Each screen carries a stable `label`. The generated README lists those rather
 * than the live paths, because the group and identity ids change on every demo
 * boot and a regenerated README differing only by uuid is a diff nobody can
 * review.
 *
 * Flags:
 *   --only=<substring>   re-shoot just the matching screens
 *   --out=<dir>          write somewhere other than `screenshots/`
 *   --light              capture the light theme instead of dark
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * `@playwright/test` is a devDependency of `@prick/e2e` alone, and pnpm does not
 * hoist it to the root, so it is resolved from the package that declares it
 * rather than from here.
 */
const require = createRequire(pathToFileURL(join(REPO, 'e2e', 'package.json')));
const { chromium } = require('@playwright/test');

const flag = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const PORT = process.env['PRICK_DEMO_PORT'] ?? '7788';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = resolve(REPO, flag('out') ?? 'screenshots');
const ONLY = flag('only');
const DARK = !process.argv.includes('--light');

const WIDTH = 1440;
const MIN_HEIGHT = 900;

/**
 * A ceiling on the grown viewport, so one long list cannot produce a 30,000px
 * image. A page taller than this is captured to this height and SAID SO, rather
 * than silently cropped -- a screenshot that quietly loses its last rows is
 * worse than one labelled as partial.
 */
const MAX_HEIGHT = 2200;

const api = async (path, init) => {
  const response = await fetch(BASE + path, init);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status}`);
  return response.json();
};

const reachable = await fetch(BASE + '/api/v1/health')
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) {
  console.error(`Nothing is serving ${BASE}. Start it with:\n\n  mise run demo\n`);
  process.exit(1);
}

const identities = await api('/api/v1/identities');
const projects = await api('/api/v1/projects');
const admin = identities.find((i) => /admin/i.test(i.displayName ?? '')) ?? identities[0];

/*
 * The fixture ships no groups, and a groups screen with nothing on it says
 * nothing about the feature. So one is created if none exists -- which does
 * mean the audit screenshot carries a few `group.*` rows from this script. The
 * demo database is thrown away when the server stops, so nothing survives it.
 */
const existing = await api('/api/v1/groups');
let group = existing[0] ?? null;
if (!group) {
  group = await api('/api/v1/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slug: 'platform',
      name: 'Platform engineering',
      description: 'On call for the shared Workers, the queues and anything with a cron on it.',
    }),
  });
  for (const who of identities.slice(0, 3)) {
    await api(`/api/v1/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity_id: who.id }),
    });
  }
  for (const grant of [
    { scope_type: 'global', role: 'reader' },
    { scope_type: 'project', project: projects[0].slug, role: 'admin' },
  ]) {
    await api(`/api/v1/groups/${group.id}/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(grant),
    });
  }
}

/**
 * Which project each shot uses is deliberate rather than incidental: the
 * fixture scopes its project and environment grants to `atlas`, so an access
 * screen pointed at any other project photographs the empty state.
 */
const withSecrets = projects.find((p) => p.slug === 'billing') ?? projects[0];
const withGrants = projects.find((p) => p.slug === 'atlas') ?? projects[0];

/** The screens. Both settings screens are deliberately absent. */
const shots = [
  { name: '01-projects', label: 'Projects list', path: '/projects', ready: 'table' },
  {
    name: '02-project-overview',
    label: "A project's environments",
    path: `/p/${withSecrets.slug}`,
    ready: 'text=Environments',
  },
  {
    name: '03-environment-secrets',
    label: 'Secrets in one environment',
    path: `/p/${withSecrets.slug}/production`,
    ready: 'table',
  },
  {
    name: '04-environment-history',
    label: 'Versions by key, and the change feed',
    path: `/p/${withSecrets.slug}/production/history`,
    ready: 'h1',
  },
  {
    name: '05-project-access',
    label: 'Grants scoped to one project',
    path: `/p/${withGrants.slug}/access`,
    ready: 'h1',
  },
  { name: '06-access', label: 'Install-wide grants', path: '/access', ready: 'h1' },
  { name: '07-users', label: 'Identities Access has presented', path: '/users', ready: 'table' },
  {
    name: '08-user-detail',
    label: 'Effective permissions for one identity',
    path: `/users/${admin.id}`,
    ready: 'h1',
  },
  { name: '09-groups', label: 'Groups list', path: '/groups', ready: 'h1' },
  {
    name: '10-group-detail',
    label: "A group's grants",
    path: `/groups/${group.id}`,
    ready: 'h1',
  },
  { name: '11-audit', label: 'Audit log', path: '/audit', ready: 'table' },
  {
    name: '12-command-palette',
    label: 'The command palette',
    path: '/projects',
    ready: 'table',
    palette: true,
  },
];

const queue = ONLY ? shots.filter((shot) => shot.name.includes(ONLY)) : shots;
if (queue.length === 0) throw new Error(`--only=${ONLY} matches no screen`);

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: MIN_HEIGHT },
  deviceScaleFactor: 2,
  colorScheme: DARK ? 'dark' : 'light',
  reducedMotion: 'reduce',
});
const page = await context.newPage();

/*
 * A broken screen still photographs, and a picture of an error boundary looks
 * enough like a page to be committed by accident. So anything the browser
 * complains about is collected and reported at the end.
 */
const problems = [];
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) {
    problems.push(`${response.status()} ${response.url().replace(BASE, '')}`);
  }
});

let clipped = 0;
for (const shot of queue) {
  await page.setViewportSize({ width: WIDTH, height: MIN_HEIGHT });
  await page.goto(BASE + shot.path, { waitUntil: 'networkidle' });
  await page.waitForSelector(shot.ready, { timeout: 15_000 });

  // The theme is applied by a client script, so it is asserted rather than assumed.
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (dark !== DARK) throw new Error(`${shot.name}: wanted dark=${DARK}, got dark=${dark}`);

  if (shot.palette) {
    await page.keyboard.press('ControlOrMeta+k');
    await page.waitForSelector('[role=dialog]', { timeout: 5_000 });
    // The project list loads on first open. Waiting for it means the picture is
    // not of a half-populated palette.
    await page.waitForSelector(`text=${withGrants.name}`, { timeout: 5_000 });
  }

  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const grown = Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT);
  if (grown !== MIN_HEIGHT) {
    await page.setViewportSize({ width: WIDTH, height: grown });
    await page.waitForTimeout(250);
  }

  await page.screenshot({ path: join(OUT, `${shot.name}.png`) });

  const note = height > MAX_HEIGHT ? `  PARTIAL: page is ${height}px` : '';
  console.log(`${shot.name.padEnd(24)} ${String(grown).padStart(5)}px${note}`);
  if (height > MAX_HEIGHT) clipped += 1;
}

await browser.close();

await writeFile(
  join(OUT, 'README.md'),
  `# Screenshots

Generated by \`mise run screenshots\`. Do not edit by hand.

Captured from the seeded demo server, ${DARK ? 'dark' : 'light'} theme, ${WIDTH}px wide at 2x.
The viewport is grown to each page's own content height rather than using a
full-page capture, because the sidebar and header are sticky -- a full-page
capture paints them once at the top and leaves the rest of the column empty.

Everything shown is fixture data from \`e2e/seed.sql\`, plus one group the script
creates so the group screens are not empty. Secret values are masked by the UI
itself; no real credential appears in any of these.

${shots.map((shot) => `- \`${shot.name}.png\` — ${shot.label}`).join('\n')}

The two settings screens are deliberately absent.
`,
);

console.log(`\n${queue.length} written to ${OUT}`);
if (clipped > 0) console.log(`${clipped} page(s) taller than ${MAX_HEIGHT}px, captured partially`);
if (problems.length > 0) {
  console.log('\nthe browser complained:');
  for (const problem of new Set(problems)) console.log(`  ${problem}`);
  process.exitCode = 1;
}
