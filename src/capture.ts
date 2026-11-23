import { Context, Effect, Layer, Schema } from 'effect';

const Incoming = Schema.Struct({
  channel: Schema.Literals(['telegram', 'whatsapp']),
  id: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  text: Schema.String,
});

type Channel = typeof Incoming.Type.channel;
type MessageKey = Pick<typeof Incoming.Type, 'channel' | 'id'>;
type Receipt = 'sent' | 'unknown';
type Voice = {
  size?: number;
  mimeType?: string;
  download?: () => Promise<Uint8Array | ArrayBuffer>;
};

class StorageFailure extends Schema.TaggedError<StorageFailure>()('StorageFailure', {
  cause: Schema.Defect(),
}) {}

class VoiceFailure extends Schema.TaggedError<VoiceFailure>()('VoiceFailure', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

class ReplyFailure extends Schema.TaggedError<ReplyFailure>()('ReplyFailure', {
  cause: Schema.Defect(),
}) {}

class DiaryStorage extends Context.Service<
  DiaryStorage,
  {
    owner(channel: Channel): Effect.Effect<string | null, StorageFailure>;
    pair(channel: Channel, userId: string): Effect.Effect<boolean, StorageFailure>;
    exists(message: MessageKey): Effect.Effect<boolean, StorageFailure>;
    save(
      message: MessageKey & { text: string },
      audio: { key: string; bytes: Uint8Array<ArrayBuffer>; mimeType?: string } | null,
    ): Effect.Effect<void, StorageFailure>;
    claimReceipt(message: MessageKey): Effect.Effect<{ audio_key: string | null } | null, StorageFailure>;
    finishReceipt(message: MessageKey, status: Receipt): Effect.Effect<void, StorageFailure>;
  }
>()('buddy-bot/DiaryStorage') {}

const storage = <A>(use: () => Promise<A>) =>
  Effect.tryPromise({ try: use, catch: (cause) => new StorageFailure({ cause }) });

export function cloudflareDiary(db: Pick<D1Database, 'prepare'>, files: Pick<R2Bucket, 'put'>) {
  return Layer.succeed(DiaryStorage, {
    owner: (channel) =>
      storage(() =>
        db.prepare('SELECT user_id FROM test_owners WHERE channel=?').bind(channel).first<string>('user_id'),
      ),
    pair: (channel, userId) =>
      storage(async () => {
        const result = await db
          .prepare('INSERT OR IGNORE INTO test_owners (channel,user_id) VALUES (?,?)')
          .bind(channel, userId)
          .run();
        return Boolean(result.meta.changes);
      }),
    exists: ({ channel, id }) =>
      storage(async () =>
        Boolean(
          await db.prepare('SELECT 1 FROM diary WHERE channel=? AND message_id=?').bind(channel, id).first(),
        ),
      ),
    save: ({ channel, id, text }, audio) =>
      storage(async () => {
        if (audio) {
          await files.put(audio.key, audio.bytes, {
            httpMetadata: { contentType: audio.mimeType ?? 'application/octet-stream' },
          });
        }
        await db
          .prepare(
            'INSERT OR IGNORE INTO diary (channel,message_id,owner,text,audio_key,audio_bytes) VALUES (?,?,?,?,?,?)',
          )
          .bind(channel, id, 'owner', text, audio?.key ?? null, audio?.bytes.byteLength ?? null)
          .run();
      }),
    claimReceipt: ({ channel, id }) =>
      storage(() =>
        db
          .prepare(`UPDATE diary SET receipt='sending'
      WHERE channel=? AND message_id=? AND receipt='pending' RETURNING audio_key`)
          .bind(channel, id)
          .first<{ audio_key: string | null }>(),
      ),
    finishReceipt: ({ channel, id }, status) =>
      storage(async () => {
        await db
          .prepare('UPDATE diary SET receipt=? WHERE channel=? AND message_id=?')
          .bind(status, channel, id)
          .run();
      }),
  });
}

const audioLimit = 1024 * 1024;

export const capture = Effect.fn('capture')(function* (
  input: unknown,
  voice: Voice | undefined,
  policy: { testUser?: string; pairCode?: string },
  reply: (text: string) => Promise<unknown>,
) {
  const message = yield* Schema.decodeUnknownEffect(Incoming)(input);
  const diary = yield* DiaryStorage;
  const user = policy.testUser ?? (yield* diary.owner(message.channel));
  const respond = (text: string) =>
    Effect.tryPromise({ try: () => reply(text), catch: (cause) => new ReplyFailure({ cause }) });

  if (policy.pairCode && message.text.trim() === policy.pairCode) {
    if (user && user !== message.userId) return;
    if (yield* diary.pair(message.channel, message.userId)) yield* respond('Canale di test collegato.');
    return;
  }
  if (message.userId !== user || (!message.text.trim() && !voice)) return;

  if (!(yield* diary.exists(message))) {
    let audio = null;
    if (voice) {
      const download = voice.download;
      if (!download || (voice.size ?? 0) > audioLimit) return yield* new VoiceFailure({});
      const bytes = yield* Effect.tryPromise({
        try: download,
        catch: (cause) => new VoiceFailure({ cause }),
      });
      if (!bytes.byteLength || bytes.byteLength > audioLimit) return yield* new VoiceFailure({});
      audio = {
        key: message.channel + '/' + encodeURIComponent(message.id),
        bytes: new Uint8Array(bytes),
        mimeType: voice.mimeType,
      };
    }
    yield* diary.save(message, audio);
  }

  const receipt = yield* diary.claimReceipt(message);
  if (!receipt) return;
  // An ambiguous provider failure must not trigger a second confirmation.
  const status = yield* respond(receipt.audio_key ? 'Vocale salvato.' : 'Annotazione salvata.').pipe(
    Effect.match({ onFailure: (): Receipt => 'unknown', onSuccess: (): Receipt => 'sent' }),
  );
  yield* diary.finishReceipt(message, status);
});
