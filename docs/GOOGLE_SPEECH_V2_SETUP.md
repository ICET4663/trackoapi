# Google Speech-to-Text V2 setup

Tracko uses Google Speech-to-Text V2 Chirp for recorded-message transcription in
English, Hausa, Yoruba, and Igbo. Text and transcript translation continues to use
Cloud Translation with an API key.

## Google Cloud

1. Enable Cloud Speech-to-Text API and Cloud Translation API.
2. Create a service account dedicated to Tracko transcription.
3. Grant it `Cloud Speech Client` (`roles/speech.client`).
4. Create a JSON key for the service account and store it securely. Never commit it.
5. Keep the existing API key restricted to Cloud Translation API.

## Backend Vercel variables

Add these to the `trackoapi` project for Production and Preview:

```text
GOOGLE_CLOUD_API_KEY=<translation API key>
GOOGLE_CLOUD_PROJECT_ID=<project_id from the service account JSON>
GOOGLE_CLOUD_CLIENT_EMAIL=<client_email from the service account JSON>
GOOGLE_CLOUD_PRIVATE_KEY=<private_key from the service account JSON>
GOOGLE_SPEECH_LOCATION=us-central1
GOOGLE_SPEECH_MODEL=chirp_2
```

Paste the private key as one Vercel value, including its BEGIN/END lines. The backend
accepts either real line breaks or escaped `\n` line breaks.

Redeploy `trackoapi`, sign in, then request `GET /v1/integrations/status`. A complete
configuration reports:

```json
{
  "translation": {
    "transcriptionApi": "speech-to-text-v2-chirp",
    "multilingualTranscriptionEnabled": true
  }
}
```
