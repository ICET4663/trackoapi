-- Tracko media storage bucket for KYC documents, driver documents, delivery proof, and voice/media attachments.
-- Run this in Supabase SQL Editor before enabling SUPABASE_SERVICE_ROLE_KEY on the backend.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tracko-media',
  'tracko-media',
  true,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'video/mp4',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Tracko public media read" on storage.objects;
create policy "Tracko public media read"
on storage.objects
for select
using (bucket_id = 'tracko-media');
