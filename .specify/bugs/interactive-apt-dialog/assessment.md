# Bug Assessment: Installer hangs on the needrestart "Which services should be restarted?" dialog

- **Slug:** interactive-apt-dialog
- **Status:** confirmed (reported screen + interface-level reproduction)
- **Severity:** blocking — a fresh install never completes, and the retry then fails on dpkg

## Symptom and reproduction

Menu option 1 (full install) on Ubuntu 22.04 stops at a whiptail checklist titled
"Daemons using outdated libraries", asking "Which services should be restarted?" and listing
`packagekit.service`, `unattended-upgrades.service`, and others. Pressing Enter or the
arrow keys does nothing; the keys appear as literal `^[[A` / `^[[B`. The operator abandons
the install, and later attempts fail as well.

## Evidence and root cause

The dialog belongs to **needrestart**, which apt runs as a hook after shared libraries are
upgraded. It is not debconf and not one of the installer's prompts. `needrestart(1)`
documents `NEEDRESTART_MODE` as an override of the configured mode — `(l)ist only`,
`(i)nteractive`, `(a)utomatically` — and the Ubuntu default is interactive
([man page](https://manpages.ubuntu.com/manpages/noble/man1/needrestart.1.html)).
`DEBIAN_FRONTEND=noninteractive` does not change it, and the installer only exported that
one variable, inside `install_packages()`, so the hook still opened its UI on the
controlling terminal.

Two secondary defects turned one stuck dialog into a broken machine state:

1. **No apt call detached stdin.** On a `curl … | sudo bash` run the interpreter and apt
   share the same pipe, so the hook can consume script lines; on a terminal whose
   TERM/terminfo does not match, whiptail renders but never parses keys — which is exactly
   the echoed `^[[A` / `^[[B` in the report. A fully non-interactive apt cannot render the
   dialog at all, so both cases disappear together.
2. **The retry had no recovery.** A run killed at the dialog leaves dpkg half-configured
   and the apt lock held. The next attempt then dies with "dpkg was interrupted, you must
   manually run 'dpkg --configure -a'", so "just install it again" fails too.

## Remediation

Export a non-interactive apt policy before the first apt call, persist
`$nrconf{restart} = 'l';` under `/etc/needrestart/conf.d/`, route every apt call through a
single helper (`-y`, bounded `DPkg::Lock::Timeout`, `--force-confdef`, `--force-confold`,
`</dev/null>`), repair an interrupted dpkg before installing, and detach the installer from
a piped stdin. Apply the same policy to `install/ubuntu22.sh`, the nginx installs in
`scripts/public-dashboard.sh` and `scripts/install-domain-helper.sh`, `scripts/uninstall.sh`
and the zstd bootstrap in `scripts/gmweb-lib.sh`.

## Out of scope

Ubuntu 24.04 changed needrestart to an "always restart" Ubuntu mode
([LP #2068543](https://bugs.launchpad.net/ubuntu/+source/needrestart/+bug/2068543)); the
dialog does not appear there. The fix keeps list-only as the explicit policy on every
release and does not attempt to emulate 24.04 behaviour on 22.04.
