-- drizzle-kit push cannot auto-cast text → enum; fix any remaining strokePreset text columns.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'strokePreset'
      AND c.udt_name = 'text'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN "strokePreset" TYPE "train_stroke_preset" USING ("strokePreset"::text::"train_stroke_preset")',
      r.table_name
    );
  END LOOP;
END $$;
