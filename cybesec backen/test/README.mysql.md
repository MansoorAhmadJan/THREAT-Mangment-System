# Patch audit MySQL integration tests

Run this suite from the repository root in a clean, dedicated PowerShell session. Clear inherited `NODE_OPTIONS` before starting Node so a preload cannot load application configuration. The suite generates its own JWT secret and refuses to run if `JWT_SECRET` is already set.

When the two test schemas are ready, opt in and run the suite explicitly.

```powershell
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
if (Test-Path Env:JWT_SECRET) {
    throw 'Use a clean PowerShell session without the application JWT configuration.'
}

$testPassword = Read-Host 'Password for isolated ctms_test_import' -AsSecureString
try {
    $env:CTMS_MYSQL_IT_USER = 'ctms_test_import'
    $env:CTMS_MYSQL_IT_PASSWORD = [System.Net.NetworkCredential]::new('', $testPassword).Password
    $env:CTMS_MYSQL_IT = '1'
    node --test 'cybesec backen/test/patches.mysql.test.js'
    if ($LASTEXITCODE -ne 0) { throw "MySQL integration tests exited with code $LASTEXITCODE." }
} finally {
    Remove-Item Env:CTMS_MYSQL_IT, Env:CTMS_MYSQL_IT_USER, Env:CTMS_MYSQL_IT_PASSWORD `
        -ErrorAction SilentlyContinue
    $testPassword.Dispose()
}
```

The masked prompt passes the password through the test process environment. Keep the password out of shell commands and repository files.

The suite uses only `127.0.0.1:3307` and requires server UUID `f54d7901-e572-11f1-bc8c-c018033e952e`. It verifies the selected database on every connection checkout. It runs serially against `ctms_audit_it_upgrade` and `ctms_audit_it_fresh`, both of which must have the application schema and no `trg_patch_insert` trigger.

The test account needs `SELECT`, `INSERT`, and `DELETE` on `users`, `analysts`, `systems`, `patches`, and `auditlogs`, and `UPDATE` on `systems`, within those test schemas. It also needs a direct schema-level `TRIGGER` grant on each test schema so MySQL shows all trigger metadata. If the grant is missing or `trg_patch_insert` is present, the suite stops that case before creating fixtures. The suite runs no DDL.

The suite uses a loopback-only Express server and deletes only its own fixtures. If a request times out, cleanup waits for the server's response path and a confirmed commit or rollback. If settlement stays unconfirmed, the suite reports the fixture identifier, leaves those rows for inspection, and blocks the remaining cases. Inspect only the verified test schema before deciding whether to remove those fixtures.
