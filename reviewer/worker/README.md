# Sweep trigger (Cloudflare Worker)

Starts each repo's `nightly-sweep.yml` on the minute. GitHub's own `schedule` trigger is
best-effort — on vices it ran the sweep 7 to 10 hours late three nights running — so the
schedule lives here and GitHub only runs what it is told to.

The Worker authenticates as the reviewer's GitHub App: it signs a JWT with the App's private
key, mints an installation token scoped to the one repository and `actions: write`, and POSTs
to the workflow's dispatch endpoint. Nothing expires. The App's installation already holds
`actions: write` (every sweep's log prints the token's permissions), so no new approval is needed.

## One-time setup (the owner's accounts; nothing here is delegated)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up, then open
   **Workers & Pages** in the dashboard once. That first visit creates the account's
   `workers.dev` subdomain; without it a deploy that attaches cron schedules fails with
   error code 10063.
2. From the code-reviewer checkout, log in and deploy. Wrangler is pinned, not installed:
   ```
   npx --yes wrangler@4.153.0 login
   npx --yes wrangler@4.153.0 deploy --config worker/wrangler.toml
   ```
3. Give it the App's credentials. Each prompt reads the value from the terminal and sends it
   straight to Cloudflare; nothing is written to the repo.
   ```
   npx --yes wrangler@4.153.0 secret put GITHUB_APP_CLIENT_ID --config worker/wrangler.toml
   npx --yes wrangler@4.153.0 secret put GITHUB_APP_PRIVATE_KEY --config worker/wrangler.toml
   ```
   The client id is on the App's settings page (`Iv1.…` / `Iv23…`). The private key is the `.pem`
   downloaded from the same page; paste it whole, `BEGIN RSA PRIVATE KEY` to `END`, no
   conversion needed. On macOS `pbcopy < path/to/key.pem` then paste at the prompt.
4. Check it. A deployed cron cannot be fired by hand from the dashboard; the first scheduled
   run is the test. The next morning, the Worker's page in the dashboard shows the invocation
   under **Cron Events** / **Logs**, and
   `gh run list -R <owner/repo> --workflow nightly-sweep.yml` shows a run with event
   `workflow_dispatch` at the scheduled minute.

   To exercise the code before then, run it locally with the secrets in a `worker/.dev.vars`
   file (`KEY=value` lines; the file is git-ignored):
   ```
   npx --yes wrangler@4.153.0 dev --config worker/wrangler.toml --test-scheduled
   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=17+7+*+*+*"
   ```
   That dispatches a real run on the repo. Delete `.dev.vars` afterwards.

## Add a repo

1. Install the App on the repo (GitHub → the App's settings → Install App), as the code reviewer
   itself needs anyway.
2. Run `/devkit:install` in the repo. It writes `devkit.json`, with the repo's sweep hour in
   `sweep.hour`, and runs the generator (`plugin/generator/`), which writes
   `.github/workflows/nightly-sweep.yml`: dispatchable, with no `schedule`, since the Worker is
   the schedule. Never write or edit that workflow by hand; change `devkit.json` and sync.
3. Temporary, until the Worker finds projects through the App and reads each one's hour from
   its `devkit.json` (ADR 0004): add one line to `worker/src/repos.ts` with the repo and its
   slot, at the hour its `devkit.json` gives. Slots are an hour apart so two sweeps never share
   the Claude subscription; if the slot is new, add it to `crons` in `worker/wrangler.toml` too
   (a test fails if a repo names a cron the file does not list). Then deploy:
   `npx --yes wrangler@4.153.0 deploy --config worker/wrangler.toml`.

Times are UTC: `17 7 * * *` is 2:17 am Eastern in winter and 3:17 in summer.

## When it fails

A dispatch that fails — key revoked, App uninstalled from the repo, workflow file renamed,
permission removed — throws, and Cloudflare records the cron invocation as failed with the
GitHub status and body in the Worker's logs (dashboard → the Worker → Logs, or
`npx --yes wrangler@4.153.0 tail --config worker/wrangler.toml`). A cron that no repo is
scheduled on fails the same way, so a stale `wrangler.toml` is noticed, not ignored.

The check that the sweep actually ran does not depend on any of this:
`gh run list -R <owner/repo> --workflow nightly-sweep.yml` shows each night's run, and the minor
findings digest ends with the commit the last sweep saw. A sweep that started and then stopped
fails its run, which GitHub notifies about like any failed workflow.
