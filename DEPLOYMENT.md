# Deployment

The game is a static Vite build on Firebase Hosting at
**https://overclock-game.web.app**, deployed by GitHub Actions.

| Event | What happens |
|---|---|
| Push to `main` | Install, `pnpm test`, `pnpm build`, deploy to the live channel |
| Open a pull request | Same gates, then a preview channel with its own URL, posted as a PR comment, expiring after 7 days |

Nothing deploys that has not passed the suite first. `pnpm build` runs
`tsc --noEmit` before Vite, so the typecheck is part of the same gate — there is
no separate step for it.

## The pieces

```
firebase.json                      hosting config — what is served and how it is cached
.firebaserc                        pins the default project to overclock-game
.github/workflows/deploy.yml       main -> live channel
.github/workflows/pr-preview.yml   pull request -> preview channel
```

The deploy needs one GitHub repository secret,
`FIREBASE_SERVICE_ACCOUNT_OVERCLOCK_GAME`, holding a service-account JSON key.
Both workflows read it by that exact name. Nothing else is configured on the
GitHub side.

## Hosting config, and the one thing that is not obvious

Vite builds to `dist/`, which is what Hosting serves. Every path rewrites to
`/index.html` so deep links survive a reload.

Caching is split: the hashed files under `/assets/**` never change content under
a given name, so they get a year and `immutable`; the entry point must not be
cached or a deploy would not reach anyone still holding an old copy.

The non-obvious part, which cost a wrong deploy to find: **header rules match
the request path, not the file a rewrite resolves to.** Keying `no-cache` on
`/index.html` looks correct and does nothing useful — a player loading `/` never
requests that path, so the entry point kept Firebase's one-hour default. The
working shape is a broad `**` rule for `no-cache` listed *first*, with the
`/assets/**` rule after it, because when several rules match the same header,
**the last one wins**. That ordering is load-bearing; reversing the two blocks
silently makes every asset uncacheable.

Verify it after any change to those rules:

```bash
curl -sI https://overclock-game.web.app/ | grep -i cache-control
```

`/`, `/index.html` and any deep link should report `no-cache`; anything under
`/assets/` should report `public, max-age=31536000, immutable`.

## Why the suite has a 30-second timeout

`vite.config.ts` sets `testTimeout: 30_000`. The sim tests simulate — the replay
test spends ~2.4s of real ticks on a dev machine — and a two-core CI runner is
about 2.2× slower than a dev machine, which put that test past Vitest's 5s
default and failed the first green-path deploy. The ceiling is high enough to
stop timing the hardware and still low enough to catch a genuine hang.

## Setting this up from scratch

Only needed on a new project or if the service account is ever revoked.

**1. Enable the IAM API before anything else.** A Firebase project created
through the console does not have it on, and the CLI's failure mode is
misleading: it tries to create a service account, swallows the error, then asks
for a key on an account that was never created and reports
`404 ... serviceAccounts/github-action-<n>@... does not exist`. The 404 is a
symptom; the missing API is the cause.

https://console.cloud.google.com/apis/library/iam.googleapis.com

**2. Sign in and wire up the repository.**

```bash
firebase login
```

```bash
firebase init hosting:github
```

Give it the repository (`moccadroid/overclock`). It creates the service account,
grants it Hosting rights, and uploads the key to GitHub as
`FIREBASE_SERVICE_ACCOUNT_OVERCLOCK_GAME`.

**Answer no to both workflow questions.** They offer to generate workflow files,
and the ones in this repo already do that job with the suite gating the deploy —
the generated ones check out the repo and deploy immediately, with no install,
no build and no tests, so they would publish an empty `dist` and race ours for
the same commit. The CLI writes `.github/workflows/firebase-hosting-pull-request.yml`
regardless of the answers given. Delete it.

**3. If the CLI still fails, do it by hand.** Same end state:

- Create a service account: https://console.cloud.google.com/iam-admin/serviceaccounts
- Grant it **Firebase Hosting Admin** — enough for both live and preview channels.
- Keys → Add Key → Create new key → JSON.
- Paste the whole file into the repository secret
  `FIREBASE_SERVICE_ACCOUNT_OVERCLOCK_GAME`
  (Settings → Secrets and variables → Actions).
- Delete the downloaded key. Once GitHub has it, the copy on disk is a live
  credential sitting in a Downloads folder.

## Deploying by hand

CI owns the live channel; this is for when it is down or being debugged. It
deploys whatever is in `dist/`, so build first — a stale `dist` publishes
silently and looks like it worked.

```bash
pnpm build && firebase deploy --only hosting
```

To try something against real Hosting without touching what players see, use a
temporary channel. It gets its own URL and expires on its own:

```bash
firebase hosting:channel:deploy scratch --expires 1h
```

```bash
firebase hosting:channel:delete scratch
```

## Rolling back

There is no rollback command in the CLI. Use the release history in the console —
Hosting → Release history → the ⋮ menu on a previous release → Rollback. It
republishes that exact version immediately.

https://console.firebase.google.com/project/overclock-game/hosting

Rolling back does not change `main`, so the next push deploys forward again over
it. Revert the commit too, or the rollback lasts until someone pushes.

## Things worth knowing

- The repository is public, so Actions minutes are free and unlimited. A full
  run is around 80 seconds, roughly half of it the test suite.
- The workflows warn that `actions/checkout@v4`, `actions/setup-node@v4` and
  `pnpm/action-setup@v4` target a deprecated Node version. Runners currently
  force a newer one anyway; when that stops being true it is a version bump.
- `package.json` carries a `packageManager` field. CI resolves pnpm from it, so
  bumping pnpm locally without updating that field makes the runner and the dev
  machine disagree.
