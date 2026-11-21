import { once } from 'node:events';
import { origin } from './origin.mjs';

export async function openOrigin(t) {
  const server = origin().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}
