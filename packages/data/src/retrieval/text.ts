/**
 * Shared text handling for keyword search and the heuristic reranker.
 *
 * STOPWORDS is the standard NLTK English list (as tokenised here, so "don't" contributes
 * "don" and "t"), plus common Hinglish function words. It is a general list, not one tuned
 * to particular questions. Without it, "the" alone matches 28 of the 30 policy clauses,
 * and a long ticket ORs its way into nearly every clause.
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  // NLTK English
  (
    "i me my myself we our ours ourselves you your yours yourself yourselves he him his himself " +
    "she her hers herself it its itself they them their theirs themselves what which who whom " +
    "this that these those am is are was were be been being have has had having do does did " +
    "doing a an the and but if or because as until while of at by for with about against between " +
    "into through during before after above below to from up down in out on off over under again " +
    "further then once here there when where why how all any both each few more most other some " +
    "such no nor not only own same so than too very s t can will just don should now d ll m o re " +
    "ve y ain aren couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn " +
    "weren won wouldn " +
    // Hinglish function words
    "hai hain ho hota hoti tha thi ka ki ke ko se mein mera mere meri tera aap aapka kya kab " +
    "kaise bhi toh aur ya nahi na hi ye yeh wo woh"
  ).split(" "),
);

/** Words: letters, combining marks (Devanagari vowel signs) and digits. Lower-cased. */
export const words = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

/** Words worth matching on. If a query is nothing but stopwords, keep them rather than nothing. */
export function contentWords(text: string): string[] {
  const all = words(text);
  const content = all.filter((w) => !STOPWORDS.has(w));
  return content.length ? content : all;
}
