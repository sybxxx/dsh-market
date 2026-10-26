# Local Maintenance

This fork adds installed-plugin source categories and folder actions. It is
based on upstream `v1.70.2` (`e320461`). The maintainer's desktop was switched
from `1.66.47` to the local `1.70.2-sybxxx.1` package on 2026-10-26. Building
or testing this checkout does not install it.

## Desktop Deployment

Install only with DSH fully closed and after an explicit deployment approval.
Take a fresh verified checkpoint, retain the original package and profile
files, then add the local archive with the bundled pnpm in offline,
ignore-scripts mode. Preserve all other dependency declarations and lockfile
entries. Compare installed code with the reviewed build and hash-check the
other packages; distinguish pnpm's workspace-state cache from plugin code.
Do not edit hard-linked files under the installed node_modules directory.

The first desktop deployment returned the custom version from the running
host's capabilities/status routes and served the new installed-tools route.
The native desktop UI also showed the custom version, source filter and
directory controls. Opening a real file-manager window was not verified in
this deployment; the isolated tests remain the evidence for that boundary.
No model request was sent for installation verification. The protected
upstream updater still refuses to replace this local installation.

## Repositories and Updates

- `origin`: https://github.com/sybxxx/dsh-market.git
- `upstream`: https://github.com/dsh-market/dsh-market.git
- Keep this checkout independent of the outer DeepSeek-Harness repository.
- `npm run upstream:check` fetches upstream refs and reports commits not yet
  merged. It never merges, pushes, installs, or restarts anything. It is an
  on-demand check, not a background monitor.
- To adopt updates, use a separate integration branch, merge the reviewed
  upstream release, resolve conflicts, then run the relevant tests and build.
  Keep the custom version suffix and fork repository metadata.
- Do not use the external upstream market updater to update this fork. The
  maintained updater under the outer repository's `tools/dsh-market-updater/`
  now refuses protected profiles, local install sources and fork metadata
  before process control or installation. Its per-profile policy can also
  protect a fork that is still being prepared. This is not a global filesystem
  lock: manual package-manager commands or old script copies can bypass it.
- Installation still requires a separate, explicit local-package workflow.
  The adjacent `market-snapshot.cjs` makes a verified checkpoint without
  stopping DSH. A running-app checkpoint does not authorize replacement or
  restart; take a fresh checkpoint when actual installation is approved.

## Responsibilities

- `src/plugin-provenance.ts`: shared category types and automatic defaults.
- `src/installed-locations.ts`: filesystem validation, local-request admission,
  and the OS file-manager launcher (argument arrays, no command shell).
- `src/installed-management.ts`: three host routes and the durable metadata file.
- `src/client/InstalledSourceTools.tsx`: source editor, folder actions, and
  category filter shared by installed cards and grouped rows.
- `src/provenance-store.ts`: versioned local association storage. The original
  `installed-management.ts` exports remain compatible for existing callers.
- `src/upstream-types.ts`: shared explicit upstream identity and baseline.
- `src/upstream-network.ts`: bounded public npm/GitHub metadata reads.
- `src/upstream-tracker.ts`: persisted observations, cooldowns, scheduled checks
  and cancellation. It never invokes Git, pnpm, merge, install or restart.
- `src/client/UpstreamTools.tsx`: association fields and read-only observations.

## Upstream Tracking (1.70.2-sybxxx.2)

This is a development update, not an automatic replacement of the installed
desktop market. A user explicitly links the original GitHub repository and
selects either its npm release package or a GitHub branch. Both can record
the last merged version and full 40-character upstream commit; npm comparison
uses the recorded version, and branch comparison uses the recorded commit.
The custom installed version is never the baseline. Missing baselines remain
unknown, rather than being initialized to the current latest version.

The market's own association is reachable from the header's Market upstream
icon even though the market itself is excluded from the installed-card grid.
Observations appear in cards and grouped rows; pending upstream changes have
their own count. They do not enter Update all or authorize an online restore.
Checking never advances a baseline. Updating that record after an actual
verified merge is a separate explicit edit. Stale editors are refused when
another window has changed the upstream association.

The host checks explicitly linked, currently installed packages 15 seconds
after mounting, then sweeps every 30 minutes. A successful observation is
fresh for six hours; failed checks wait 30 minutes. Explicit checks have a
one-minute minimum interval. At most 32 associations and two simultaneous
checks are allowed. Each inspection has a total 15-second deadline and at
most two requests; response bodies are capped at 2 MiB. Checks stop and abort
in-flight reads when the market is disposed. The client polls saved results
once a minute while visible and linked; it does not issue external requests.

Metadata reads use the existing `marketFetch` proxy transport and fixed
official origins: registry.npmjs.org and api.github.com. npm metadata must
declare both the configured package name and the configured GitHub repository.
Redirects, arbitrary hosts, credentials in URLs and unsupported identities are
refused. No GitHub token is read or stored. npm mode follows `latest`, not
unpublished commits; branch mode compares an immutable fetched head with the
saved commit using GitHub's ancestry response. Diverged/ahead histories are
not advertised as synchronized or automatically mergeable. See the
[GitHub commit/compare contract](https://docs.github.com/en/rest/commits/commits)
and [npm metadata contract](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md).

`plugin-provenance.json` retains optional `upstream` fields in its version-1
records. Observations are separate in `.dsh-market/upstream-checks.json`, keyed
to the complete association and baseline. A changed or removed association
invalidates stale responses. Atomic read/modify/write updates keep concurrent
checks for different plugins from overwriting one another. Unknown or corrupt
records fail visibly, without silently resetting the file. Rate-limit backoff
is capped at one day and survives restart. Generic failures never become
"current"; the previous pending result remains visible, labeled as previous.
Expired successes are labeled as awaiting a recheck.
If disk storage fails, the current process shows a storage error and observes
the same cooldown in memory; it cannot promise to retain that failed attempt
across a restart. The previous on-disk file is not replaced or reset.

Existing metadata without an upstream field remains valid and sends no new
external requests. Downgrading to the previous custom build can strip these
new fields when its older source editor saves a record: back up metadata
before a downgrade. No automatic migration or edit of the maintainer's live
plugin settings is performed during development.

Categories are display metadata, not package-manager instructions. Local
`file:` and `link:` installations default to **Unclassified**, not to an
inferred author. Registry/Git installations and desktop-managed generations
default to **Online original** according to the configured source; this is
not a byte-level integrity claim. Users can explicitly choose Online original,
Local original, or Customized/Fork, or restore Automatic. No installation,
update eligibility, conversation data, or existing plugin configuration is
changed by classification.

## Local Data and Folder Actions

`<profile>/.dsh-market/plugin-provenance.json` stores a versioned map of explicit
categories and optional source-folder associations. It is separate from
`state.json`: ordinary toggles/groups/notes writes and hot-mount cleanup do not
erase it. An atomic rename publishes each bounded write, after rereading the
current map. Invalid or unknown-format data is reported, never silently reset.
Do not commit this file: source paths are machine-specific. Associations
survive ordinary upgrades; stale or mismatched folders must be relinked.

Installed folders come from the selected profile's `node_modules`. Local
directory specs can supply a source folder automatically; a `.tgz` is an
archive, not a source checkout. A manually linked source folder must contain
the same package name (including installed aliases). There is no inferred
mapping from an archive to a Git checkout elsewhere on disk.

The open route accepts only a package name and one of `installed`, `source`,
or `archive`. It rechecks current installation and filesystem identity on
every request. It does not accept an arbitrary path to launch, rejects remote,
forwarded and cross-origin requests, and rejects UNC/device paths. The normal
host authentication gate still wraps these routes. Opening an archive opens
its containing folder. Success means the OS accepted the launch request,
not that a visible Explorer window was independently observed. There is no
write/edit/delete operation on a plugin's code.

## Validation

```sh
npm ci --ignore-scripts
npm run typecheck
npx vitest run tests/installed-management.spec.ts tests/installed-locations-spawn.spec.ts tests/client/installed-source-tools.client.spec.tsx
npm run check
npm run test:sources:browser
npx vitest run tests/upstream-tracking.spec.ts tests/upstream-management.spec.ts tests/client/upstream-tools.client.spec.tsx
```

Host tests use disposable profiles and a fake file-manager boundary, including
a real loopback HTTP request. Browser/component tests cover classifications,
source editing, errors, duplicate clicks, stale reads, filtering and reload.
No real provider/model calls, publishing, production installs or restarts are
part of these checks.

The browser check uses Vite, the actual market components and host handlers,
and disposable profile data. npm's ui-primitives package has CSS stubs, so the
fixture supplies representative host chrome; it is not a screenshot of the
running desktop application. Set `PLAYWRIGHT_CHANNEL=msedge` to use an existing
Edge installation instead of downloading a browser. Screenshots go to the
ignored `output/playwright/` directory. The file-manager boundary is recorded,
not launched, so this check does not open windows on the developer's desktop.

Known baseline on this Windows machine: the seven-file host regression run
has 712 passing tests and two failing uninstall bridge-link cleanup tests
(`#662`, `tests/flows.spec.ts`). Both failures were reproduced unchanged in a
separate worktree at upstream `e320461`. The installation/uninstall code was
not modified to hide those failures. Revisit them before a production rollout;
this development checkpoint does not claim the entire upstream suite is green.

For the upstream-tracking update, the focused behavioral/component lane passes
63 tests. The broader UI/network/flow run passes 676 tests and retains only
the same two `#662` baseline failures. Real-browser fixtures also cover setting
an association, a numerically higher custom version, release and branch
checks, saved baselines, failure evidence, scope switching and narrow layouts.
Public npm and GitHub metadata were additionally inspected read-only through
the built network module; no live profile records were created by that probe.
