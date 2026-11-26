# Meshwari database backup and restore

These scripts are operator-run and deliberately do not connect to Render or alter production configuration.

## Prerequisites
- PostgreSQL client tools matching the server major version (`pg_dump`, `pg_restore`, `psql`).
- `age` encryption utility and `gzip`.
- A private age identity stored offline or in an approved secret manager. Never commit it.
- A separate age public recipient for encryption. The private identity is required only for restore.

## Create an encrypted backup
Set `DATABASE_URL`, `BACKUP_AGE_RECIPIENT`, and optionally `BACKUP_DIR`, then run:

```sh
bash scripts/db-backup.sh
```

The script writes a custom-format PostgreSQL dump, compresses it, encrypts it before writing the final file, and creates a SHA-256 checksum. Temporary plaintext is streamed through a pipe rather than saved as a dump file. Protect the output directory and copy backups to storage separate from the application host.

## Test a restore safely
Create a new, disposable PostgreSQL database that is not production. Set:
- `BACKUP_FILE` to an encrypted backup.
- `BACKUP_AGE_IDENTITY` to the private age identity file.
- `RESTORE_TEST_DATABASE_URL` to the disposable test database.

Then run:

```sh
bash scripts/db-restore-test.sh
```

This command destroys/replaces objects in the database named by `RESTORE_TEST_DATABASE_URL` because it uses `pg_restore --clean --if-exists`. Never point it at production. After restore, run application-level checks for account counts, trips, wallet ledger balances by currency, admin access, and representative trip histories. Then run `bash scripts/db-verify-restore.sh` with the same disposable `RESTORE_TEST_DATABASE_URL` to verify required tables, migration history, row counts, currency-wallet reconciliation exceptions, and legacy movements with unknown currency. The verification output must be reviewed and compared with the backup manifest; the script does not automatically certify data correctness.

## Operational policy still required
- Schedule backups at least daily, and more frequently after material financial changes.
- Retain daily, weekly, and monthly copies in a separate account/location.
- Keep encryption identity recovery copies offline and access-controlled.
- Perform a restore drill at least monthly and record duration and row-count reconciliation.
- Define RPO/RTO with operations; a backup is not proven until restored and reconciled.
- Do not rely on a backup stored only on the same service or disk as the database.

No schedule or remote storage destination is configured by these scripts. Configure those through the hosting/storage provider after an explicit operations decision.
