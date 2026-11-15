import 'reflect-metadata';
import { createApp, setupOpenApi } from './bootstrap-app';
import { config } from './common/config';

async function main() {
  const app = await createApp();
  if (config.appEnv !== 'production') setupOpenApi(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  console.log(JSON.stringify({ service: 'ravzo-api', event: 'listening', port: config.port, env: config.appEnv, paymentsLive: config.paymentsLiveEnabled }));
}
main();
