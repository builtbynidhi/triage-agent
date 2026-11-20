import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import type { TriageStore } from "@triage/data";

export const POLICY_URI_PREFIX = "policy://";

/**
 * Policy documents as MCP resources (policy://returns, policy://refunds, ...), alongside
 * search_policy. A client can list and read a whole policy directly, which is how a person
 * in Claude Desktop checks what the agent is citing.
 */
export function registerPolicyResources(server: McpServer, store: TriageStore): void {
  server.registerResource(
    "policy",
    new ResourceTemplate(`${POLICY_URI_PREFIX}{doc}`, {
      list: async () => ({
        resources: (await store.listPolicyDocuments()).map((d) => ({
          uri: `${POLICY_URI_PREFIX}${d.doc}`,
          name: d.doc,
          title: d.title,
          description: `Clauses: ${d.clauseIds.join(", ")}`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Support policies",
      description:
        "The merchant's support policy documents, one per topic, with stable clause IDs.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const doc = String(variables.doc);
      const found = (await store.listPolicyDocuments()).find((d) => d.doc === doc);
      if (!found) throw new Error(`No policy document "${doc}"`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: found.markdown }] };
    },
  );
}
