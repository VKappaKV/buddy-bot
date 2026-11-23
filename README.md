# Buddy Bot

Buddy Bot è un assistente personale su Telegram e WhatsApp. Raccoglie annotazioni e vocali, collega evidenze da GitHub e Linear agli obiettivi e pubblica il diario in un vault Obsidian dedicato. Quando una nota viene modificata in Obsidian, il bot conserva la modifica e propone eventuali aggiornamenti da confermare in chat.

Questo README documenta le decisioni di progetto e le prove del primo prototipo.

## Decisione sullo stack

Aggiornamento del 23 novembre 2026. Buddy Bot adotta Ratstack come riferimento per l’applicazione TypeScript e l’infrastruttura su Cloudflare. Cloudflare ospita l’applicazione e i dati operativi. Obsidian Sync collega il vault ai dispositivi.

| Componente               | Scelta                                                            | Motivazione                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Applicazione             | TypeScript strict e Effect 4 su Cloudflare Workers                | Le regole del diario e la validazione con Effect Schema sono condivise fra i canali. Le operazioni dichiarano gli errori previsti e usano servizi sostituibili per archivio, file e invio.       |
| Infrastruttura           | Alchemy v2 con `@alchemy.run/cloudflare`                          | Dichiara risorse e collegamenti Cloudflare in TypeScript. Si parte da Worker, D1 e R2. Queues, Cron Triggers e il Container con Durable Object entrano quando i rispettivi flussi li richiedono. |
| Canali del bot           | Vercel Chat SDK per Telegram e WhatsApp Business Cloud            | Gli adapter traducono i messaggi nella stessa operazione di acquisizione. Chat SDK ha superato la prova locale dal telefono su Telegram. La prova WhatsApp resta in sospeso.                     |
| Sviluppo locale          | Node.js 24 e pnpm                                                 | pnpm installa le dipendenze ed esegue i comandi del progetto. Alchemy avvia il Worker in `workerd`.                                                                                              |
| Configurazione e qualità | Varlock, Oxlint, Oxfmt, Vitest, `@effect/vitest` e Lefthook       | Varlock valida le variabili. GitHub Actions e il pre-commit eseguono gli stessi controlli e test.                                                                                                |
| Collegamenti             | GitHub App e Linear OAuth                                         | GitHub accede ai repository selezionati. Linear usa lo scope `read`.                                                                                                                             |
| Stato del diario         | Cloudflare D1                                                     | Conserva fonti, obiettivi, revisioni e lavori da eseguire. L’acquisizione e la registrazione del lavoro avvengono nella stessa transazione.                                                      |
| Lavori in background     | Cloudflare Queues e Cron Triggers                                 | Gestiscono reminder, trascrizioni, import e report. Ogni lavoro ha un identificativo stabile per gestire le riconsegne.                                                                          |
| File e ripristino        | Cloudflare R2 privato e D1 Time Travel                            | R2 conserva audio temporaneo, versioni delle note e backup cifrati. Time Travel consente il ripristino del database a un momento precedente.                                                     |
| Vault                    | Cloudflare Containers, un Durable Object e Obsidian Headless Sync | Una sola istanza Linux sincronizza il vault in modo continuo. Il Durable Object gestisce l’avvio e il riavvio dell’istanza.                                                                      |
| AI                       | Cloudflare Workers AI                                             | Llama 3.3 70B per report e proposte strutturate e Whisper Large v3 Turbo per i vocali sono i primi candidati da provare su un corpus italiano.                                                   |

## Adozione di Ratstack

- **Prima prova.** Alchemy avvia in locale il Worker con D1 e R2. Ricezione, salvataggio e conferma passano per un’operazione Effect condivisa. Il bot conferma i messaggi già salvati e D1 conserva la deduplicazione fra richieste e riavvii. [Guida Ratstack](https://ratstack.sh/llms.txt) · [Effect 4](https://effect.website/blog/effect-v4-rc-september-recap) · [Alchemy in locale](https://alchemy.run/environments/local-development/)
- **Configurazione.** Varlock valida le variabili definite in `.env.schema`. I valori di test restano in file locali esclusi da Git. Il lockfile fissa le versioni delle dipendenze. [Varlock](https://varlock.dev/)
- **Componenti da introdurre quando servono.** Foldkit per le schermate web di collegamento e impostazioni. Valutare XState per flussi con stati, annullamento o ripresa quando emergerà il primo caso concreto. [Componenti opzionali di Ratstack](https://ratstack.sh/README.md#keep-or-cut)

## Canali di contatto

Telegram e WhatsApp fanno parte dell’MVP per annotazioni e vocali. **Chat SDK è stato verificato su Telegram per ricezione, salvataggio e conferma.** La verifica con WhatsApp reale resta in sospeso. Per la prima prova, i promemoria automatici partono su Telegram. Fuori dalla finestra di 24 ore dall’ultimo messaggio ricevuto, WhatsApp richiede un template approvato da Meta. [Adapter Telegram](https://chat-sdk.dev/adapters/official/telegram) · [Adapter WhatsApp](https://chat-sdk.dev/adapters/official/whatsapp) · [Regole WhatsApp Business](https://business.whatsapp.com/policy)

## Come passano i dati

- Telegram e WhatsApp sono associati allo stesso proprietario. Il bot risponde sul canale d’origine dopo aver salvato la fonte in D1. Per i vocali la conferma di acquisizione segue il salvataggio in R2. La raccolta continua durante un guasto dell’AI o della sincronizzazione.
- Una modifica in Obsidian viene conservata prima dell’analisi e sospende la riscrittura della nota. La conferma in Telegram vale per la versione mostrata. Una modifica successiva rende obsoleta la proposta.
- Il Container ricostruisce il vault da Obsidian Sync e riprende le pubblicazioni pendenti da D1 e R2 dopo aver confrontato le versioni. Il disco del Container è effimero e gli snapshot Cloudflare dipendono dalla versione dell’immagine. Il recupero deve riuscire anche con un’immagine nuova.

## Prova dal telefono del 23 novembre 2026

- **Telegram — superata.** Chat SDK ha ricevuto un testo e un vocale reali da telefono su un Worker locale raggiunto tramite tunnel HTTPS temporaneo. D1 contiene una voce per messaggio e R2 contiene il vocale da 5.305 byte. Il bot ha inviato entrambe le conferme dopo il salvataggio. Webhook e tunnel sono stati chiusi a fine prova.
- **Telegram con Alchemy ed Effect 4 — superata.** Lo stesso flusso ha salvato un testo in D1 e un vocale da 5.011 byte in R2. Entrambe le conferme sono state inviate e i dati sono rimasti disponibili dopo il riavvio. Webhook e tunnel sono stati chiusi.
- **WhatsApp — in sospeso.** La prova dal telefono e il download reale dei vocali tramite Meta restano da svolgere.

## Avvio locale

Dalla radice del progetto, con Node.js 24 o successivo e la versione di pnpm indicata in `package.json`, eseguire questi comandi.

```sh
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm check
pnpm test
pnpm dev
```

Alchemy avvia il Worker su `127.0.0.1:8878`, emula D1 e R2 e applica le migrazioni in `migrations/`. I dati locali stanno in `.alchemy/`. Il codice del webhook è in `src/worker.ts` e il flusso Effect di acquisizione è in `src/capture.ts`. `BUDDY_TEST_TELEGRAM_PORT` collega una finta API Telegram sulla stessa macchina.

`pnpm check` valida lo schema con Varlock, controlla i tipi con TypeScript ed esegue Oxlint e Oxfmt. `pnpm format` applica la formattazione. Lefthook e GitHub Actions eseguono `pnpm check` e `pnpm test`.

Vitest esegue i test del Worker con Miniflare e API simulate. Verifica il salvataggio prima della conferma, i duplicati, le riconsegne dopo un errore e la persistenza dopo il riavvio. Per WhatsApp usa un trasporto simulato per scaricare i vocali. `@effect/vitest` verifica direttamente che il flusso Effect rifiuti un messaggio senza ID. Se il Worker si interrompe durante una conferma, l’acquisizione resta salvata e la conferma può restare in sospeso.

### Ripetere il test Telegram dal telefono

1. Salvare il token del bot di test in `.dev.vars` come `TELEGRAM_BOT_TOKEN` o `TELEGRAM_TOKEN`. In `.dev.vars.phone`, impostare `BUDDY_TELEGRAM_PHONE_TEST=true` e generare due valori casuali distinti per `TELEGRAM_WEBHOOK_SECRET` e `TELEGRAM_PAIR_CODE`. Questi file e `.alchemy/` sono locali e possono contenere segreti.
2. Avviare il Worker e il tunnel in due terminali.

   ```sh
   pnpm dev:phone --stage buddy-phone-local
   cloudflared tunnel --url http://127.0.0.1:8878 --http-host-header 127.0.0.1:8878
   ```

3. Registrare il webhook con `node --env-file=.dev.vars --env-file=.dev.vars.phone scripts/telegram-webhook.mjs set <URL-del-tunnel>`. Il comando rifiuta di sostituire un webhook già configurato per un altro indirizzo.
4. Inviare il codice di associazione al bot. Dopo «Canale di test collegato.», inviare un testo e un vocale breve. Il bot risponde «Annotazione salvata.» e «Vocale salvato.».
5. A fine prova rieseguire il comando del punto 3 con `clear` al posto di `set`, quindi chiudere il tunnel e il Worker.

## Verifiche aperte

1. **Canali e Chat SDK.** La suite locale con eventi simulati ha coperto messaggi ravvicinati, duplicati, guasti di salvataggio e riavvio. Quando riprende la prova WhatsApp, verificare un testo e un vocale dal telefono con il numero di test Meta e un endpoint HTTPS temporaneo. Controllare che ogni messaggio distinto resti nel diario una sola volta e che la conferma parta dopo il salvataggio. [Concorrenza in Chat SDK](https://chat-sdk.dev/docs/usage) · [Stato su Cloudflare](https://developers.cloudflare.com/agents/agent-class/communication-channels/chat-sdk/) · [Tunnel di sviluppo](https://developers.cloudflare.com/workers/local-development/local-dev-tunnels/)
2. **Vault.** La prima prova di Obsidian Sync è stata eseguita. Obsidian Sync resta la scelta per il vault. Ripristino da disco vuoto e cambio immagine con pubblicazione pendente restano da verificare su Cloudflare. [Obsidian Headless Sync](https://obsidian.md/help/sync/headless) · [Snapshot Cloudflare](https://developers.cloudflare.com/containers/guides/snapshots/)
3. **Modelli e costo.** Confrontare qualità, latenza e costo su almeno 30 casi testuali e 20 vocali in italiano. Come riferimento al 20 novembre 2026, Workers Paid più memoria e disco di un Container `basic` acceso 30 giorni valgono circa **12 USD/mese**, da integrare con CPU oltre la franchigia, AI, dominio, imposte e Obsidian Sync. Il tetto mensile resta da fissare. [Prezzi Cloudflare Containers](https://developers.cloudflare.com/containers/platform/pricing/)
