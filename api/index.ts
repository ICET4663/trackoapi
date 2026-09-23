import { createTrackoApp } from '../src/create-app';

let cachedServer: any;
let bootstrapPromise: Promise<any> | undefined;

async function getServer() {
  if (cachedServer) return cachedServer;

  bootstrapPromise ??= createTrackoApp()
    .then(({ app }) => {
      cachedServer = app.getHttpAdapter().getInstance();
      return cachedServer;
    })
    .catch((error) => {
      bootstrapPromise = undefined;
      throw error;
    });

  return bootstrapPromise;
}

export default async function handler(request: any, response: any) {
  const server = await getServer();
  return server(request, response);
}
