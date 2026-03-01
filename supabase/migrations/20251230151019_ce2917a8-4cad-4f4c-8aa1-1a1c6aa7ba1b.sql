-- Delete all TG marketing entries that don't have a category (uncategorized)
DELETE FROM tg_marketing WHERE category_id IS NULL;

-- Verify: Keep only entries from HS_Group_Related_Username category
-- All other entries (if any from other categories) should also be deleted
DELETE FROM tg_marketing 
WHERE category_id IS NOT NULL 
AND category_id NOT IN (
  SELECT id FROM tg_marketing_categories WHERE name = 'HS_Group_Related_Username'
);