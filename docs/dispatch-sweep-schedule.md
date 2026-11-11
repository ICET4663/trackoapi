# Running the dispatch sweep every 5 minutes

`GET /v1/cron/dispatch-sweep` funds paid checkouts whose customer never came back, passes unanswered driver
offers to the next driver, and offers waiting shipments. It is meant to run every 5 minutes.

## Why GitHub Actions is not enough

`.github/workflows/dispatch-sweep.yml` is scheduled `*/5 * * * *`, but GitHub drops most scheduled runs on
busy hours and makes no promise about timing. Measured on 10 Nov 2026: 65 runs between 26 Oct and 10 Nov, with a
**median gap of 5.5 hours** (shortest 2.7 h, longest 10.7 h). Every run succeeded; there were simply very few.

What that means in practice:

| Job | Other trigger | Worst case with GitHub only |
|---|---|---|
| Pass an unanswered offer to the next driver | A driver opening their job list, or staff opening the assignment queue | Hours, when nobody opens those screens |
| Fund a paid checkout whose customer never returned | The Paystack webhook, if its URL is set in the Paystack dashboard | About 10 hours |
| Offer a waiting shipment to a driver who became free | A driver switching availability on | Hours |

## Fix: Supabase scheduler (pg_cron + pg_net)

The production database is on Supabase, which can call a URL on a schedule. Two schedulers calling the
sweep at the same time is safe: offer expiry and payment funding are conditional updates, so a second run finds
nothing left to do. Keep the GitHub workflow as a backup.

In the Supabase dashboard of the production project, **Integrations** (or **Database, Extensions**): turn on
`pg_cron` and `pg_net`. Then in the **SQL editor**, replacing `PASTE_CRON_SECRET` with the API's `CRON_SECRET`
from Vercel (the same value as the GitHub secret):

```sql
-- Stored encrypted in Supabase Vault, not in the job text.
select vault.create_secret('PASTE_CRON_SECRET', 'trako_cron_secret', 'Bearer token for /v1/cron/*');

select cron.schedule(
  'trako-dispatch-sweep',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://trackoapi.vercel.app/v1/cron/dispatch-sweep',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'trako_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);
```

### Check it after 10 minutes

```sql
-- The job ran (status 'succeeded' means the request was queued, not that the API accepted it).
select start_time, status, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'trako-dispatch-sweep')
order by start_time desc limit 5;

-- The API's answer: 200 with {"pendingPayments":...,"assignments":...,"matching":...}.
-- 403 means the secret does not match Vercel's CRON_SECRET.
select created, status_code, left(content::text, 200) as body
from net._http_response order by created desc limit 5;
```

### Change or stop it

```sql
-- New secret (after rotating CRON_SECRET on Vercel and GitHub):
select vault.update_secret(
  (select id from vault.secrets where name = 'trako_cron_secret'), 'NEW_CRON_SECRET');

-- Stop the job:
select cron.unschedule('trako-dispatch-sweep');
```

`net._http_response` keeps responses for 6 hours by default, so it does not grow without limit.
`cron.job_run_details` grows by about 290 rows a day; clear old rows occasionally:
`delete from cron.job_run_details where end_time < now() - interval '7 days';`
