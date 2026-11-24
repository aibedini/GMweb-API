# Bug Verification: headless apt for the installer

- **Slug:** interactive-apt-dialog
- **Result:** verified at the script/interface level; the affected host was not reachable from
  this workspace, so the end-to-end install there is NOT VERIFIED.

## What was verified

| Evidence | Command | Result |
| --- | --- | --- |
| Syntax, all touched bash | `bash -n` (Git Bash, and again on Ubuntu 22.04.5 LTS) | 6/6 OK on both |
| Helper contract (static) | `node --test test/installerHeadlessApt.test.js` | 7/7 pass |
| Helper behaviour on Ubuntu 22.04 bash | probe sources the real `install/quick-install.sh` with stubbed `apt-get`/`dpkg` | see below |
| JS syntax | `npm run check` | exit 0 |
| Unit/contract suite | `npm test` | 988 tests, 987 pass, 0 fail, 1 skipped |

Behaviour probe on the Ubuntu 22.04 host (real bash 5.1, the target platform), running the
actual helpers from the modified installer:

```text
--- apt args ---
-y -o DPkg::Lock::Timeout=120 -f install
-y -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::Retries=3 update
-y -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::Retries=3 install curl
--- apt env ---
mode=l tty=no stdin=/dev/null        (x3)
--- dpkg calls ---
--configure -a
--- conf ---
$nrconf{restart} = 'l';
```

That is the whole failure mode removed: apt sees `NEEDRESTART_MODE=l`, stdin is
`/dev/null` (so whiptail cannot take the terminal or the script's pipe), every call is
`-y` with a bounded lock, and the interrupted-dpkg state from the earlier stuck run is
repaired with `--configure -a` before installing.

The needrestart contract itself was checked against the upstream documentation:
`NEEDRESTART_MODE` overrides the configured restart mode with `(l)ist only`,
`(i)nteractive`, `(a)utomatically` ([needrestart(1)](https://manpages.ubuntu.com/manpages/noble/man1/needrestart.1.html)).
Ubuntu 24.04's "always restart" change ([LP #2068543](https://bugs.launchpad.net/ubuntu/+source/needrestart/+bug/2068543))
does not reintroduce a prompt, and list-only remains the explicit policy.

## NOT VERIFIED

- The real dialog disappearing on the machine in the screenshot. That host was not reachable
  from this workspace (the only reachable Ubuntu 22.04 box has no `needrestart` installed,
  and installing it there would mutate a production server). The operator must re-run the
  install on that host; the new code is what makes that run immune.
- A full `install/quick-install.sh` end-to-end run on Ubuntu 22.04 with Chrome/VNC/Redis.
  No disposable Ubuntu host with `needrestart` was available, and the installer is not run
  on the Windows development machine.
- `install/ubuntu22.sh` end-to-end. Same reason; only `bash -n` and the shared helper probe
  cover it.

## Note on the local full-suite run

The first `npm test` on this checkout failed only `test/frontendArtifacts.test.js`:
`PWA build-info version drift: 0.20.0 != 0.20.8`. `public/web-app/build-info.json` is a
git-ignored local build artifact left over from a 0.20.0 build; it is absent from every CI
checkout (`git check-ignore` confirms the path is ignored). It was removed from this
worktree — no tracked file changed — and the suite then passed 987/987 with 1 skip.
