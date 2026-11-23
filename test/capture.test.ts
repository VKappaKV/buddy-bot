import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { capture, cloudflareDiary } from '../src/capture.ts';

it.effect('rifiuta un messaggio senza ID prima di accedere al diario o confermare', () =>
  Effect.gen(function* () {
    const unexpected = (): never => {
      throw new Error('Il messaggio non valido non deve accedere al diario né inviare conferme');
    };
    const diary = cloudflareDiary({ prepare: unexpected }, { put: unexpected });
    const error = yield* capture(
      { channel: 'telegram', id: '', userId: '2718', text: 'Nota' },
      undefined,
      { testUser: '2718' },
      unexpected,
    ).pipe(Effect.provide(diary), Effect.flip);

    expect(error._tag).toBe('SchemaError');
  }),
);
