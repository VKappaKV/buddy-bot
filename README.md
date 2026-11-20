# Buddy Bot

Buddy Bot è un assistente personale su Telegram. Raccoglie annotazioni e vocali, collega evidenze da GitHub e Linear agli obiettivi e pubblica il diario in un vault Obsidian dedicato. Quando una nota viene modificata in Obsidian, il bot conserva la modifica e propone eventuali aggiornamenti da confermare in Telegram.

## Decisione sullo stack

Decisione del 20 novembre 2026. Cloudflare ospita l’applicazione e i dati operativi. Obsidian Sync collega il vault ai dispositivi.

| Componente | Scelta | Motivazione |
| --- | --- | --- |
| Bot e collegamenti | TypeScript, Cloudflare Workers e grammY | Gestisce il webhook Telegram, i comandi e le schermate essenziali di collegamento. GitHub App con accesso ai repository selezionati e Linear OAuth con scope `read`. |
| Stato del diario | Cloudflare D1 | Conserva fonti, obiettivi, revisioni e lavori da eseguire. L’acquisizione e la registrazione del lavoro avvengono nella stessa transazione. |
| Lavori in background | Cloudflare Queues e Cron Triggers | Gestiscono reminder, trascrizioni, import e report. Ogni lavoro ha un identificativo stabile per gestire le riconsegne. |
| File e ripristino | Cloudflare R2 privato e D1 Time Travel | R2 conserva audio temporaneo, versioni delle note e backup cifrati. Time Travel consente il ripristino del database a un momento precedente. |
| Vault | Cloudflare Containers, un Durable Object e Obsidian Headless Sync | Una sola istanza Linux sincronizza il vault in modo continuo. Il Durable Object gestisce l’avvio e il riavvio dell’istanza. |
| AI | Cloudflare Workers AI | Llama 3.3 70B per report e proposte strutturate e Whisper Large v3 Turbo per i vocali sono i primi candidati da provare su un corpus italiano. |

## Come passano i dati

- Telegram riceve conferma dopo la registrazione durevole. Per i vocali la conferma di acquisizione segue il salvataggio in R2. La raccolta continua durante un guasto dell’AI o della sincronizzazione.
- Una modifica in Obsidian viene conservata prima dell’analisi e sospende la riscrittura della nota. La conferma in Telegram vale per la versione mostrata. Una modifica successiva rende obsoleta la proposta.
- Il Container ricostruisce il vault da Obsidian Sync e riprende le pubblicazioni pendenti da D1 e R2 dopo aver confrontato le versioni. Il disco del Container è effimero e gli snapshot Cloudflare dipendono dalla versione dell’immagine. Il recupero deve riuscire anche con un’immagine nuova.

## Verifiche aperte

1. **Vault.** Su un vault di test, provare sincronizzazione nei due sensi, modifiche offline, conflitti con entrambe le versioni recuperabili, riavvio a disco vuoto e cambio immagine con una pubblicazione in attesa. Obsidian Headless Sync è in beta. La prova è il prerequisito principale del pilota. [Obsidian Headless Sync](https://obsidian.md/help/sync/headless) · [Snapshot Cloudflare](https://developers.cloudflare.com/containers/guides/snapshots/)
2. **Acquisizione.** Con Wrangler verificare riavvio, riconsegna di un messaggio e continuità della raccolta durante un guasto dei servizi a valle. [Transazioni D1](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [Consegna di Cloudflare Queues](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
3. **Modelli e costo.** Confrontare qualità, latenza e costo su almeno 30 casi testuali e 20 vocali in italiano. Come riferimento al 20 novembre 2026, Workers Paid più memoria e disco di un Container `basic` acceso 30 giorni valgono circa **12 USD/mese**, da integrare con CPU oltre la franchigia, AI, dominio, imposte e Obsidian Sync. Il tetto mensile resta da fissare. [Prezzi Cloudflare Containers](https://developers.cloudflare.com/containers/platform/pricing/)
