# Deploy the patch audit trigger removal

Coordinate this migration with the backend release that writes the patch audit row inside the patch creation transaction.

## Before running the migration

1. Confirm the approved MySQL server UUID and schema name against the backend's deployment configuration. Connect with the deployment account and explicitly select that database. For an integration rehearsal, use the disposable MySQL instance, its test-only credentials, and the upgrade test schema.
2. Verify the server and database in the same MySQL session that will run the migration. Stop if the UUID differs, the database is `NULL`, or the database differs from the expected schema. If the migration runner opens another connection, repeat this check on that connection before executing the file.

   ```sql
   SELECT @@server_uuid AS server_uuid, DATABASE() AS selected_database;
   ```

3. Pause patch creation across all backend instances, pause external writers and imports that can insert into `patches`, and drain in-flight writes. Work out how any external writer will audit patch creation before resuming it.
4. Check that the trigger exists in the selected schema and that it is the expected `AFTER INSERT` trigger on `patches`.

   ```sql
   SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
   FROM information_schema.TRIGGERS
   WHERE TRIGGER_SCHEMA = DATABASE()
     AND TRIGGER_NAME = 'trg_patch_insert';
   ```

   Run the check with a deployment account that has `TRIGGER` privilege on the target `patches` table so it can see and drop the trigger. If the trigger is absent on an expected first upgrade, stop and verify the target and deployment history. If it is absent on a retry, verify the target and locate the recovery copy from the first run.
5. If the trigger is present, save the full `SHOW CREATE TRIGGER` output in an access-controlled deployment artifact. Retain the definition, definer, SQL mode, and character-set and collation metadata. Confirm the artifact is readable before applying the migration.

   ```sql
   SHOW CREATE TRIGGER `trg_patch_insert`;
   ```

## Apply and verify

1. With patch writes still paused, run `001_drop_trg_patch_insert.sql` on the verified session without changing its default database. `IF EXISTS` makes the statement safe to run again on the same verified target.
2. Repeat the trigger query above on that session and require zero rows. Deploy the transactional audit-writing backend to every instance and verify the release version before resuming patch writes. Resume external writers only after confirming their audit path.

## Recovery

Keep writes paused if a verification step fails. `DROP TRIGGER` implicitly commits, so recovery requires a separate operation. Prefer completing the coordinated release. For a full rollback, restore the previous backend version and recreate the trigger from the saved definition using the recorded settings. Verify both before resuming writes. A full rollback brings back the previous duplicate-audit behavior.
