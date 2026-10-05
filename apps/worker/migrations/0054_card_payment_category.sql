-- 繳信用卡費從「轉帳」分出獨立的系統分類，該分類一律排除統計。
INSERT OR IGNORE INTO classification_categories
  (id, label, sort_order, is_system, created_at, updated_at) VALUES
  ('card-payment', '信用卡繳費', 17, 1, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');

UPDATE classification_categories
SET sort_order = 18, updated_at = '2026-10-05T00:00:00.000Z'
WHERE id = 'other' AND is_system = 1 AND sort_order = 17
  AND EXISTS (SELECT 1 FROM classification_categories WHERE id = 'card-payment');

-- 關鍵字與預設排除統計的判斷（calculation-service）一致；
-- 使用者已有同名自訂分類導致上方 INSERT 被略過時，規則維持原分類。
UPDATE classification_rules
SET category_id = 'card-payment',
    pattern = '信用卡.*(繳|扣款|還款|自扣)|卡費|繳卡款|繳款入帳|自扣已入帳|credit.?card.*(pay|bill|repay)|card payment|payment received',
    excluded_from_calculation = 1,
    updated_at = '2026-10-05T00:00:00.000Z'
WHERE id = 'system:bank:creditcard-payment'
  AND category_id = 'transfer'
  AND EXISTS (SELECT 1 FROM classification_categories WHERE id = 'card-payment');
