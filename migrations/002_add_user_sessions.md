# Prepare database-backed user sessions

Migration 002 is additive. Existing users remain enabled because the new column defaults to NULL. The current application does not use the session store, so this migration alone has no effect on login, logout, account changes, tokens, or Socket.IO.

## Order and verification

1. On an existing installation, confirm that the expected prior migrations, including 001, have been applied. Use migration 002 on that installation. Use the updated schema dump only for a fresh, empty installation and do not run migration 002 on top of it.
2. Before executing 002, verify the server UUID and selected schema in the same session that will run it. Stop if either differs from the approved target. Inspect the existing Users definition and verify that it is InnoDB with a signed INT primary key and no disabled_at column. Confirm that user_sessions does not already exist. Take a recovery backup and schedule the DDL with awareness of metadata locks.
3. Run 002 once on the verified target using a deployment account with ALTER, CREATE, and INSERT privileges on `users` for `ALTER TABLE`, CREATE for `user_sessions`, and REFERENCES on `users` for the foreign key. Stop on the first error. Verify the nullable disabled_at column, empty InnoDB session table, three indexes including the primary key, and the session foreign key and cascade. Existing user records and references must be preserved.
4. Rehearse both a fresh installation and an upgrade on disposable MySQL before enabling the store in the application. The schema now contains nine tables. The future runtime account will need SELECT on the relevant Users columns and SELECT, INSERT, and DELETE on user_sessions. The runtime account does not need DDL privileges for this store.

## Store contract

Create a store with the MySQL promise pool for standalone calls or an already acquired promise connection for calls that belong to a transaction. Use the same connection for related operations. The store never starts, commits, rolls back, acquires, or releases connections. Promise rejections propagate to callers. Treat failed authorization reads as unavailable and fail closed. Keep internal errors, raw session identifiers, and digests out of public responses and logs.

Session creation generates a UUID and writes only its binary SHA-256 digest. The returned raw identifier is for the future JWT jti claim. Return login success only after a successful session insert and transaction commit. A null result means no eligible account or no remaining lifetime at insert time. The store compares expiry with the database clock using Unix seconds. Future callers must supply the JWT's absolute expiry, keep the eight-hour maximum, and set disabled_at in UTC when implementing account disabling.

An active lookup binds both the user ID and the identifier digest. It returns a row only for an existing, enabled account and a session whose expiry is strictly in the future. The account-status lookup returns the stored role and disable timestamp, or null for a missing user. These reads do not acquire explicit locks. Future login and account changes must use transaction-level locking to coordinate credential verification and revocation. Dispatch-time Socket.IO ordering will need its own locking reads.

Expired-session listing returns user IDs and expiry times without session material. Cleanup independently checks expiry in the delete statement and limits each batch. No scheduler is installed by this migration.

## Partial failure and rollback

MySQL commits each DDL statement independently. If ALTER succeeds and CREATE fails, leave the additive column in place, verify its exact definition, and apply only the missing reviewed statement after resolving the error. Do not rerun the entire file blindly. If an object already exists with an unexpected definition, stop and investigate before proceeding.

The safest Phase 1 rollback is to leave the unused schema in place. If removal is required before activation, verify that the session table is empty and no account disable timestamps are in use, then obtain separate approval for removing the table and column. Once later phases have populated these objects, removal would lose session or account-state data and requires a coordinated recovery plan.

## Legacy JWTs

Existing JWTs remain compatible throughout Phase 1. No session rows are backfilled. When a later rollout starts requiring a session record, coordinate the switch across all instances and require a fresh sign-in for legacy tokens. Do not keep instances that validate only the JWT active during that cutover. Rolling back to such an instance after enforcement begins would reintroduce acceptance of revoked tokens.
