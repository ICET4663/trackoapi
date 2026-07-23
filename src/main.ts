import { createTrackoApp } from './create-app';

async function bootstrap() {
  const { app, config } = await createTrackoApp();
  const port = Number(config.get('PORT') ?? 4000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
