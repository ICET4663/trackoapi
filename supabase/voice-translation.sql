-- Adds the columns needed for cross-language message translation
-- (see src/integrations/translation-provider.service.ts and
-- CommunicationService.translateForRecipient). Safe to run even if some/all
-- columns already exist.

alter table public."User"
  add column if not exists "preferredLanguage" text not null default 'en';

alter table public."Message"
  add column if not exists "translatedText" text,
  add column if not exists "translatedLanguage" text,
  add column if not exists "sourceLanguage" text;
