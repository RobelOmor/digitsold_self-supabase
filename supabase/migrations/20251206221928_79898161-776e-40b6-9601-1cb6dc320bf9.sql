-- Create trigger function to auto-create 3 fixed subcategories when a new category is added
CREATE OR REPLACE FUNCTION public.create_fixed_subcategories()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Insert Account subcategory
  INSERT INTO subcategories (category_id, name, slug, description, sort_order)
  VALUES (NEW.id, 'Account', 'account', 'Digital accounts', 1);
  
  -- Insert Service subcategory
  INSERT INTO subcategories (category_id, name, slug, description, sort_order)
  VALUES (NEW.id, 'Service', 'service', 'Digital services', 2);
  
  -- Insert Software subcategory
  INSERT INTO subcategories (category_id, name, slug, description, sort_order)
  VALUES (NEW.id, 'Software', 'software', 'Software licenses', 3);
  
  RETURN NEW;
END;
$$;

-- Create trigger on categories table
DROP TRIGGER IF EXISTS trigger_create_fixed_subcategories ON categories;
CREATE TRIGGER trigger_create_fixed_subcategories
  AFTER INSERT ON categories
  FOR EACH ROW
  EXECUTE FUNCTION public.create_fixed_subcategories();