# Google Drive Backup

The local repository at `G:\WECRYP` is backed up to Google Drive under:

- `H:\My Drive\WECRYP\REPO`
- `H:\My Drive\WECRYP\SECRETS`
- `H:\My Drive\WECRYP\backup.log`

Backups run:

- At sign-in
- Daily at 06:00 local time
- On demand via Task Scheduler task `WECRYP Google Drive Backup`

The backup uses `scripts/backup-to-google-drive.ps1`.

Excluded directories:

- `.git`
- `node_modules`
- `WE-CRYPTO-CACHE`
- `tmp`
- `.worktrees`
- `__pycache__`
- `dist`
- `_consolidated-from-drive`
- `.tmp.driveupload`
- `.venv`
- `.codeql-results`
- `proxy`
- `we-crypto-electron`

The backup records the source commit ID in `backup.log`.
