import type { ConfigService } from "@nestjs/config";

export function fatalAlertConfig(config: ConfigService) {
  let webhook: URL | undefined;
  try {
    const candidate = new URL(
      config.get<string>("TELEMETRY_ALERT_WEBHOOK_URL")?.trim() ?? "",
    );
    if (
      candidate.protocol === "https:" &&
      !candidate.username &&
      !candidate.password
    )
      webhook = candidate;
  } catch {
    /* An invalid channel must not interrupt error reporting. */
  }
  const recipient = config.get<string>("TELEMETRY_ALERT_EMAIL")?.trim() ?? "";
  const from = config.get<string>("EMAIL_FROM")?.trim() ?? "";
  const apiKey = config.get<string>("RESEND_API_KEY")?.trim() ?? "";
  const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  const sender = from.match(/<([^<>]+)>$/)?.[1] ?? from;
  const email =
    address.test(recipient) &&
    address.test(sender) &&
    apiKey &&
    !/[\r\n]/.test(from)
      ? { recipient, from, apiKey }
      : undefined;
  return { webhook, email, configured: Boolean(webhook || email) };
}
