-- Select and verify the target database in this session before running this file.
-- Keep patch writes paused and follow 001_drop_trg_patch_insert.md for the cutover.
DROP TRIGGER IF EXISTS `trg_patch_insert`;
