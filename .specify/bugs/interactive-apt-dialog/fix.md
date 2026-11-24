# Bug Fix: headless apt for the installer

- **Slug:** interactive-apt-dialog
- **Status:** applied

`install/quick-install.sh` now exports `DEBIAN_FRONTEND=noninteractive`,
`DEBCONF_NONINTERACTIVE_SEEN=true`, `APT_LISTCHANGES_FRONTEND=none`, `NEEDRESTART_MODE=l`
and `UCF_FORCE_CONFFOLD=1` before anything else runs, and writes the durable policy
`$nrconf{restart} = 'l';` to `/etc/needrestart/conf.d/99-gmweb-headless.conf`.

All apt work goes through `apt_get()`: `-y`, `DPkg::Lock::Timeout=120`,
`--force-confdef`, `--force-confold`, `Acquire::Retries=3`, and `</dev/null>` so apt can
never read the script's own stdin. `apt_repair()` stops leftover needrestart/whiptail
processes, waits for the dpkg locks, runs `dpkg --configure -a` when `dpkg --audit` reports
unfinished work, and fixes broken dependencies before the first install — the state a
previously interrupted run leaves behind. The ufw install and the uninstall purge reuse
the same helper. A failed package step now stops the full install instead of printing
credentials for a server that was never started.

`install/ubuntu22.sh` gets the same policy with `apt_update`/`apt_install` wrappers and the
same repair step. `scripts/public-dashboard.sh`, `scripts/install-domain-helper.sh`,
`scripts/uninstall.sh` and the zstd bootstrap in `scripts/gmweb-lib.sh` set
`NEEDRESTART_MODE=l` and detach stdin on their apt calls. Finally, the installer detaches
from a piped stdin (`exec </dev/tty`) and is source-able for tests via
`GMWEB_INSTALL_LIB_ONLY=1`.

No API route, schema, or authentication behaviour changed, so `package.json` and
`docs/openapi.json` stay at the revision pulled from `main` (0.20.8).
