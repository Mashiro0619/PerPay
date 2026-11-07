// SPDX-License-Identifier: MIT
import { once } from 'node:events';

export async function listenForFetch(server) {
  for (let attempt = 0; ; attempt++) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      // Custom OS ephemeral ranges can include ports rejected by fetch.
      await fetch(base, { method: 'HEAD' });
      return base;
    } catch (error) {
      await new Promise(resolve => server.close(resolve));
      if (error.cause?.message !== 'bad port' || attempt >= 9) throw error;
    }
  }
}
