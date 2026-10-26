# Local Maintenance

This fork adds installed-plugin source categories and folder actions. It is
based on upstream `v1.70.2` (`e320461`), not the currently deployed desktop
market (`1.66.47`). Building or testing this checkout does not install it.

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
