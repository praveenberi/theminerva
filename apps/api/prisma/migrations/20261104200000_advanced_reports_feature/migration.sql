-- Plans gain a feature flag for the advanced reports (customer, staff, inventory, reservation and refund analysis).
-- Pro and Enterprise include it, so existing subscribers on those plans keep everything they were sold; admins can edit plans afterwards.
UPDATE "Plan" SET features = array_append(features, 'advanced_reports')
WHERE code IN ('PRO', 'ENTERPRISE') AND NOT ('advanced_reports' = ANY(features));
