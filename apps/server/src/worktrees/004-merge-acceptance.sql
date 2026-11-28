ALTER TABLE approvals ADD COLUMN acceptance TEXT;
ALTER TABLE approvals ADD COLUMN run_order INTEGER;
-- Historical records retain their previously published order.
UPDATE approvals SET run_order=rowid WHERE kind='command' AND status IN ('running','interrupted','complete','failed');
