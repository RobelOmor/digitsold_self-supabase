-- Create the 3 fixed subcategories (Account, Service, Software) for all categories that don't have them
DO $$
DECLARE
  cat RECORD;
BEGIN
  FOR cat IN SELECT id FROM categories WHERE is_active = true LOOP
    -- Insert Account subcategory if not exists
    INSERT INTO subcategories (category_id, name, slug, description, sort_order)
    SELECT cat.id, 'Account', 'account', 'Digital accounts', 1
    WHERE NOT EXISTS (
      SELECT 1 FROM subcategories WHERE category_id = cat.id AND LOWER(name) = 'account'
    );
    
    -- Insert Service subcategory if not exists
    INSERT INTO subcategories (category_id, name, slug, description, sort_order)
    SELECT cat.id, 'Service', 'service', 'Digital services', 2
    WHERE NOT EXISTS (
      SELECT 1 FROM subcategories WHERE category_id = cat.id AND LOWER(name) = 'service'
    );
    
    -- Insert Software subcategory if not exists
    INSERT INTO subcategories (category_id, name, slug, description, sort_order)
    SELECT cat.id, 'Software', 'software', 'Software licenses', 3
    WHERE NOT EXISTS (
      SELECT 1 FROM subcategories WHERE category_id = cat.id AND LOWER(name) = 'software'
    );
  END LOOP;
END $$;