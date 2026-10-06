import type { ConfigService } from "@nestjs/config";
import { fatalAlertConfig } from "./fatal-alert-config";
import { kycConfig } from "./kyc-config";
import { DeploymentConfigService } from "./deployment-config.service";

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as ConfigService;
const smile = {
  KYC_PROVIDER: "smile_id",
  SMILE_ID_API_KEY: "test",
  SMILE_ID_PARTNER_ID: "1234",
  SMILE_ID_CALLBACK_URL: "https://trackoapi.vercel.app",
};

describe("production integration gates", () => {
  it("does not activate Smile ID when the selected provider is mock", () => {
    expect(
      kycConfig(config({ ...smile, KYC_PROVIDER: "mock" })).configured,
    ).toBe(false);
  });
  it("requires a valid HTTPS callback origin", () => {
    for (const callback of [
      "http://api.example.test",
      "https://api.example.test/webhook",
      "https://api.example.test/?token=secret",
    ]) {
      expect(
        kycConfig(config({ ...smile, SMILE_ID_CALLBACK_URL: callback }))
          .configured,
      ).toBe(false);
    }
  });
  it("distinguishes sandbox configuration from production readiness", () => {
    expect(kycConfig(config(smile))).toMatchObject({
      configured: true,
      productionReady: false,
    });
    expect(
      kycConfig(config({ ...smile, SMILE_ID_ENVIRONMENT: "production" }))
        .productionReady,
    ).toBe(true);
  });
  it("never treats an unsupported adapter as real verification", () => {
    expect(
      kycConfig(config({ DOJAH_API_KEY: "test", KYC_PROVIDER: "dojah" }))
        .configured,
    ).toBe(false);
  });
  it("accepts Resend alerts as an alternative to a webhook", () => {
    const settings = config({
      TELEMETRY_ALERT_EMAIL: "ops@example.test",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "Trako <alerts@updates.trako.com.ng>",
    });
    expect(fatalAlertConfig(settings).configured).toBe(true);
    expect(
      new DeploymentConfigService(settings).summary().integrations,
    ).toContainEqual({
      name: "fatalErrorAlerts",
      mode: "configured",
      missing: [],
    });
  });
  it("rejects incomplete email and unsafe webhook configuration", () => {
    expect(
      fatalAlertConfig(
        config({
          TELEMETRY_ALERT_EMAIL: "not an email",
          RESEND_API_KEY: "test",
        }),
      ).configured,
    ).toBe(false);
    expect(
      fatalAlertConfig(
        config({ TELEMETRY_ALERT_WEBHOOK_URL: "http://example.test" }),
      ).configured,
    ).toBe(false);
  });
});
