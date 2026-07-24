import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { DeploymentConfigService } from './config/deployment-config.service';

export async function createTrackoApp() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  app.get(DeploymentConfigService).assertRequired();

  const configuredOrigins =
    config.get<string>('CORS_ORIGIN')?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
  const devOrigins = [
    'http://localhost:8081',
    'http://localhost:8082',
    'http://localhost:3000',
    'http://192.168.100.7:8081',
    'http://192.168.100.7:8082',
  ];
  const allowedOrigins = new Set([...configuredOrigins, ...devOrigins]);
  const allowVercelPreviews = config.get<string>('ALLOW_VERCEL_PREVIEWS') === 'true';

  app.setGlobalPrefix('v1');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.enableCors({
    origin: (origin, callback) => {
      const isVercelPreview = allowVercelPreviews && Boolean(origin?.endsWith('.vercel.app'));

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
