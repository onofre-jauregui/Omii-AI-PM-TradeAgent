-- Storage RLS policies for the avatars bucket.
-- Authenticated users can upload/update only within their own folder (user_id/).
-- Public read allows the browser to display avatars without auth.
DROP POLICY IF EXISTS avatars_upload ON storage.objects;
CREATE POLICY avatars_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);

DROP POLICY IF EXISTS avatars_update ON storage.objects;
CREATE POLICY avatars_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);

DROP POLICY IF EXISTS avatars_public_read ON storage.objects;
CREATE POLICY avatars_public_read ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'avatars');
