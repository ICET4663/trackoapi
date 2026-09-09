import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { DeploymentConfigService } from "./config/deployment-config.service";

export async function createTrackoApp() {
  // Voice notes are sent as base64 JSON. Nest's default parser limit is 100 KB,
  // which rejects even a short recording before it reaches the media controller.
  // Register one larger parser while retaining rawBody for Paystack HMAC checks.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: "4mb" });
  app.useBodyParser("urlencoded", { limit: "4mb", extended: true });
  const config = app.get(ConfigService);
  const readiness = app.get(DeploymentConfigService).summary();
  if (!readiness.deployable) {
    console.warn(
      `Tracko API started with missing environment variables: ${readiness.required.missing.join(", ")}`,
    );
  }

  const configuredOrigins =
    config
      .get<string>("CORS_ORIGIN")
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  const devOrigins = [
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:3000",
    "http://192.168.100.7:8081",
    "http://192.168.100.7:8082",
  ];
  const productionOrigins = [
    "https://trako.com.ng",
    "https://www.trako.com.ng",
    "https://cargo-link-logistics-mm1c.vercel.app",
  ];
  const allowedOrigins = new Set([
    ...configuredOrigins,
    ...productionOrigins,
    ...devOrigins,
  ]);
  const allowVercelPreviews =
    config.get<string>("ALLOW_VERCEL_PREVIEWS") === "true";

  app.setGlobalPrefix("v1");
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    next();
  });
  app.enableCors({
    origin: (origin, callback) => {
      const isVercelPreview =
        allowVercelPreviews && Boolean(origin?.endsWith(".vercel.app"));

      if (!origin || allowedOrigins.has(origin) || isVercelPreview) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return { app, config };
}
