import { createTrackoApp } from '../src/create-app';

let cachedServer: any;

export default async function handler(request: any, response: any) {
  if (!cachedServer) {
    const { app } = await createTrackoApp();
    cachedServer = app.getHttpAdapter().getInstance();
  }

  return cachedServer(request, response);
}
