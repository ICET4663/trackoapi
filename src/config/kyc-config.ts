import type { ConfigService } from "@nestjs/config";

export function kycConfig(config: ConfigService) {
  const value = (key: string) => config.get<string>(key)?.trim() ?? "";
  const provider = value("KYC_PROVIDER") || "mock";
  const missing = ["SMILE_ID_API_KEY", "SMILE_ID_PARTNER_ID"].filter(
    (key) => !value(key),
  );
  if (provider !== "smile_id") missing.unshift("KYC_PROVIDER=smile_id");
  let callback: string | null = null;
  try {
    const raw =
      value("SMILE_ID_CALLBACK_URL") ||
      (value("VERCEL_URL") ? `https://${value("VERCEL_URL")}` : "");
    const url = new URL(raw);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    )
      callback = url.origin;
  } catch {
    /* Leave automated verification disabled until a valid callback exists. */
  }
  if (!callback) missing.push("SMILE_ID_CALLBACK_URL (HTTPS origin)");
  const environment = value("SMILE_ID_ENVIRONMENT") || "sandbox";
  if (!["sandbox", "production"].includes(environment))
    missing.push("SMILE_ID_ENVIRONMENT (sandbox or production)");
  return {
    provider,
    callback,
    environment,
    missing,
    configured: missing.length === 0,
    productionReady: missing.length === 0 && environment === "production",
  };
}
