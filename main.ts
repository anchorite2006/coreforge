// Entry point: build the forge, bind an ephemeral port, register it with
// the grading environment, and serve until the environment says the trial
// is done.
//
// The lifecycle is the harness's contract: listen on port 0 (never a fixed
// port — the suite owns 8080), POST {"port": N} to $MAKEFUN_ENV_URL/register
// exactly once (the first registration wins), then long-poll
// $MAKEFUN_ENV_URL/done and exit 0 when it answers {"done": true}. When no
// environment URL is configured the server simply serves until killed,
// which is how the local conformance runner is driven during development.

import { createApp, Router } from './app.ts';
import { Forge } from './lib/store.ts';
import { LogicalClock } from './lib/clock.ts';
import { registerRestRoutes } from './lib/rest.ts';
import { registerGitHttpRoutes } from './lib/githttp.ts';
import { registerGraphQlRoutes } from './lib/graphql.ts';
import { registerMcpRoutes } from './lib/mcp.ts';

async function main(): Promise<void> {
  const ctx = {
    forge: new Forge(),
    clock: new LogicalClock(process.env.MAKEFUN_TRIAL_NOW),
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
  };
  const router = new Router();
  registerRestRoutes(router);
  registerGitHttpRoutes(router);
  registerGraphQlRoutes(router);
  registerMcpRoutes(router);
  const server = createApp(ctx, router);

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('server has no port'));
      else resolve(address.port);
    });
  });

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    console.log(`forge listening on ${port} (no MAKEFUN_ENV_URL; serving until killed)`);
    return;
  }

  const registered = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registered.ok && registered.status !== 409) {
    console.error(`register answered HTTP ${registered.status}`);
  }

  // Long-poll the environment until it reports the trial is over.
  for (;;) {
    let done = false;
    try {
      const answer = await fetch(`${envUrl}/done`);
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        done = payload.done === true;
      }
    } catch {
      // A transient environment hiccup is not the end of the trial.
    }
    if (done) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

void main();
