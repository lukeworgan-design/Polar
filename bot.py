-- Check first
SELECT a.id, a.date, a.distance_meters, a.source
FROM polar_exercises a
WHERE a.source = 'polar'
AND EXISTS (
  SELECT 1 FROM polar_exercises b
  WHERE b.source = 'manual'
  AND b.date::date = a.date::date
  AND ROUND(b.distance_meters / 100) = ROUND(a.distance_meters / 100)
);

-- Then delete
DELETE FROM polar_exercises a
WHERE a.source = 'polar'
AND EXISTS (
  SELECT 1 FROM polar_exercises b
  WHERE b.source = 'manual'
  AND b.date::date = a.date::date
  AND ROUND(b.distance_meters / 100) = ROUND(a.distance_meters / 100)
);
