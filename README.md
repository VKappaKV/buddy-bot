# Buddy Bot

Buddy Bot è un assistente personale su Telegram e WhatsApp. Raccoglie annotazioni e vocali, collega evidenze da GitHub e Linear agli obiettivi e pubblica il diario in un vault Obsidian dedicato. Quando una nota viene modificata in Obsidian, il bot conserva la modifica e propone eventuali aggiornamenti da confermare in chat.

Questo README documenta le decisioni di progetto e le prove del primo prototipo.

## Decisione sullo stack

Decisione del 20 novembre 2026, aggiornata il 23 novembre 2026 per includere entrambi i canali di contatto. Cloudflare ospita l’applicazione e i dati operativi. Obsidian Sync collega il vault ai dispositivi.

| Componente | Scelta | Motivazione |
| --- | --- | --- |
| Canali del bot | TypeScript su Cloudflare Workers, Telegram e WhatsApp Business Cloud | Entrambi i canali scrivono nello stesso diario in D1. Vercel Chat SDK ha superato la prova locale dal telefono su Telegram. La prova WhatsApp resta in sospeso. |
| Collegamenti | GitHub App e Linear OAuth | GitHub accede ai repository selezionati. Linear usa lo scope `read`. |
| Stato del diario | Cloudflare D1 | Conserva fonti, obiettivi, revisioni e lavori da eseguire. L’acquisizione e la registrazione del lavoro avvengono nella stessa transazione. |
| Lavori in background | Cloudflare Queues e Cron Triggers | Gestiscono reminder, trascrizioni, import e report. Ogni lavoro ha un identificativo stabile per gestire le riconsegne. |
| File e ripristino | Cloudflare R2 privato e D1 Time Travel | R2 conserva audio temporaneo, versioni delle note e backup cifrati. Time Travel consente il ripristino del database a un momento precedente. |
| Vault | Cloudflare Containers, un Durable Object e Obsidian Headless Sync | Una sola istanza Linux sincronizza il vault in modo continuo. Il Durable Object gestisce l’avvio e il riavvio dell’istanza. |
| AI | Cloudflare Workers AI | Llama 3.3 70B per report e proposte strutturate e Whisper Large v3 Turbo per i vocali sono i primi candidati da provare su un corpus italiano. |

## Canali di contatto

Telegram e WhatsApp fanno parte dell’MVP per annotazioni e vocali. **Chat SDK è stato verificato su Telegram per ricezione, salvataggio e conferma.** La verifica con WhatsApp reale resta in sospeso. Per la prima prova, i promemoria automatici partono su Telegram. Fuori dalla finestra di 24 ore dall’ultimo messaggio ricevuto, WhatsApp richiede un template approvato da Meta. [Adapter Telegram](https://chat-sdk.dev/adapters/official/telegram) · [Adapter WhatsApp](https://chat-sdk.dev/adapters/official/whatsapp) · [Regole WhatsApp Business](https://business.whatsapp.com/policy)

## Come passano i dati

- Telegram e WhatsApp sono associati allo stesso proprietario. Il bot risponde sul canale d’origine dopo aver salvato la fonte in D1. Per i vocali la conferma di acquisizione segue il salvataggio in R2. La raccolta continua durante un guasto dell’AI o della sincronizzazione.
- Una modifica in Obsidian viene conservata prima dell’analisi e sospende la riscrittura della nota. La conferma in Telegram vale per la versione mostrata. Una modifica successiva rende obsoleta la proposta.
- Il Container ricostruisce il vault da Obsidian Sync e riprende le pubblicazioni pendenti da D1 e R2 dopo aver confrontato le versioni. Il disco del Container è effimero e gli snapshot Cloudflare dipendono dalla versione dell’immagine. Il recupero deve riuscire anche con un’immagine nuova.

## Prova dal telefono del 23 novembre 2026

- **Telegram — superata.** Chat SDK ha ricevuto un testo e un vocale reali da telefono su un Worker locale raggiunto tramite tunnel HTTPS temporaneo. D1 contiene una voce per messaggio e R2 contiene il vocale da 5.305 byte. Il bot ha inviato entrambe le conferme dopo il salvataggio. Webhook e tunnel sono stati chiusi a fine prova.
- **WhatsApp — in sospeso.** La prova dal telefono e il download reale dei vocali tramite Meta restano da svolgere.

## Verifiche aperte

1. **Canali e Chat SDK.** La suite locale con eventi simulati ha coperto messaggi ravvicinati, duplicati, guasti di salvataggio e riavvio. Quando riprende la prova WhatsApp, verificare un testo e un vocale dal telefono con il numero di test Meta e un endpoint HTTPS temporaneo. Controllare che ogni messaggio distinto resti nel diario una sola volta e che la conferma parta dopo il salvataggio. [Concorrenza in Chat SDK](https://chat-sdk.dev/docs/usage) · [Stato su Cloudflare](https://developers.cloudflare.com/agents/agent-class/communication-channels/chat-sdk/) · [Tunnel di sviluppo](https://developers.cloudflare.com/workers/local-development/local-dev-tunnels/)
2. **Vault.** La prima prova di Obsidian Sync è stata eseguita. Obsidian Sync resta la scelta per il vault. Ripristino da disco vuoto e cambio immagine con pubblicazione pendente restano da verificare su Cloudflare. [Obsidian Headless Sync](https://obsidian.md/help/sync/headless) · [Snapshot Cloudflare](https://developers.cloudflare.com/containers/guides/snapshots/)
3. **Modelli e costo.** Confrontare qualità, latenza e costo su almeno 30 casi testuali e 20 vocali in italiano. Come riferimento al 20 novembre 2026, Workers Paid più memoria e disco di un Container `basic` acceso 30 giorni valgono circa **12 USD/mese**, da integrare con CPU oltre la franchigia, AI, dominio, imposte e Obsidian Sync. Il tetto mensile resta da fissare. [Prezzi Cloudflare Containers](https://developers.cloudflare.com/containers/platform/pricing/)
