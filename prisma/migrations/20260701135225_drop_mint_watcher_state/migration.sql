-- Mint-watcher checkpoints moved to an in-memory Map — this is informational
-- monitoring, not an accounting ledger, so a restart is meant to start fresh
-- rather than resume from a persisted checkpoint. Nothing reads this table anymore.

-- DropTable
DROP TABLE "mint_watcher_state";
