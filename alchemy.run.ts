import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Alchemy from 'alchemy';
import { Config, Effect, Option } from 'effect';

export default Alchemy.Stack(
  'BuddyPrototype',
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const context = yield* Alchemy.AlchemyContext;
    if (!context.dev) return yield* Effect.die('The Buddy prototype is local-only. Use alchemy dev.');

    const db = yield* Cloudflare.D1.Database('Diary', { migrations: './migrations' });
    const audio = yield* Cloudflare.R2.Bucket('Audio');
    const mockPort = yield* Config.option(Config.Port('BUDDY_TEST_TELEGRAM_PORT'));
    const phoneTest = yield* Config.Boolean('BUDDY_TELEGRAM_PHONE_TEST').pipe(Config.withDefault(false));
    if (phoneTest && Option.isSome(mockPort)) {
      return yield* Effect.die('Choose either the Telegram phone test or the simulated Telegram API.');
    }
    const telegram = Option.match(mockPort, {
      onNone: (): Cloudflare.WorkerBindingProps => {
        if (!phoneTest) return {};
        return {
          TELEGRAM_TOKEN: Config.Redacted('TELEGRAM_BOT_TOKEN').pipe(
            Config.orElse(() => Config.Redacted('TELEGRAM_TOKEN')),
          ),
          TELEGRAM_WEBHOOK_SECRET: Config.Redacted('TELEGRAM_WEBHOOK_SECRET'),
          TELEGRAM_PAIR_CODE: Config.Redacted('TELEGRAM_PAIR_CODE'),
        };
      },
      onSome: (port) => ({
        TELEGRAM_API_URL: 'http://127.0.0.1:' + port,
        TELEGRAM_TOKEN: '12345:fake',
        TELEGRAM_WEBHOOK_SECRET: 'local-alchemy-test',
        TELEGRAM_USER: '2718',
      }),
    });
    const worker = yield* Cloudflare.Worker('Webhook', {
      main: './src/worker.ts',
      compatibility: { date: '2026-11-02', flags: ['nodejs_compat'] },
      dev: { host: '127.0.0.1', port: 8878, strictPort: true },
      env: { DB: db, AUDIO: audio, ...telegram },
    });

    return { url: worker.url };
  }),
);
