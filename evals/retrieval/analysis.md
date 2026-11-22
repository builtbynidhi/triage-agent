## Analysis

Hand-written; the tables above are generated. The spec says Phase 4 is done when hybrid beats both single methods, _or you can explain in writing why it does not_. Here, it does on one question set and not on the other, and the reason is the most useful finding of the phase.

**On short, focused questions (held-out), hybrid with cross-encoder reranking has the highest hit@4 of all 13 configurations (96.9%) and the joint-highest hit@1 (75%), against 93.8% / 71.9% for the best vector-only method and 71.9% / 43.8% for keyword only.

**On raw customer tickets (eval-derived), it is not.** Vector-only bge-small reaches 70.4% hit@4; hybrid with the cross-encoder reaches 51.9%. Three things go wrong with a whole ticket as the query:

1. **Keyword search latches onto filler.** Before stopwords were removed, the angry-delivery ticket ("THIS IS RIDICULOUS ... it is STILL not here ... I'm never ordering again") had `contact.never_asked` as its top keyword hit, matched on the word "never". Removing stopwords (iteration 2) helped keyword search on short questions (68.8% to 71.9% held-out hit@4; the 68.8% is in commit 6c00419's report), but not on tickets (40.7% before and after): the content words of a rant are still mostly not policy words.
2. **Fusion lets a weak list pull down a strong one.** RRF weighs both lists equally by rank, so noisy keyword ranks displace good vector ranks. Hybrid without reranking falls from 70.4% (vector alone) to 55.6%.
3. **The cross-encoder is trained on short search queries** (MS MARCO). Given a paragraph of mixed complaint and question, it ranks worse than the embedding of the whole paragraph.

**Why production still uses hybrid with the cross-encoder** ([ADR 0005](adr/0005-retrieval-configuration.md)): the agent does not search with the raw ticket. It calls `search_policy` with a query it writes, and the tool description now tells it to ask one short, specific question per call and to search twice for a two-question ticket. The held-out set is the closer model of those queries, and there this configuration is best. This choice was informed by the held-out numbers, which the pre-registered rule said should only confirm, so the held-out score is no longer a clean confirmation. The real test is Phase 7, which measures retrieval with the agent's actual queries. If those turn out to look like raw tickets, vector-only is the measured fallback.

**What stays open:**

- **Eval-derived misses cluster on `refunds.window`** (it loses to `refunds.method`, `refunds.timeline` and `returns.process`, which share vocabulary), on `delivery.estimates` for "where is my order" tickets, and on `damaged.resolution` vs `damaged.reporting`. These are Phase 8 inputs.
- **A multilingual model did not help Hinglish here.** paraphrase-multilingual-MiniLM was the weakest vector model overall. Romanised Hindi ("mera order kab aayega") is not what it was trained on (Devanagari). Both Hinglish held-out questions are worth watching in Phase 7.
- **Measured on 59 questions.** One question is 3.7 points on the eval-derived set and 3.1 on the held-out set, so gaps of one or two questions are noise, not findings.
