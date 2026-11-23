"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, approvalsEnabled } from "@/lib/data";

/**
 * Approve or reject from the web UI. Off unless the operator turns it on (see approvalsEnabled in
 * lib/data.ts): this app has no login of its own.
 */
export async function decide(formData: FormData): Promise<void> {
  if (!approvalsEnabled()) throw new Error("Approving from the web UI is not enabled.");
  const id = String(formData.get("id") ?? "");
  const verb = formData.get("verb") === "reject" ? "reject" : "approve";
  if (!/^apr_[0-9a-f]+$/.test(id)) throw new Error("That is not an approval ID.");
  const res = await apiFetch(`/v1/approvals/${id}/${verb}`, { method: "POST" });
  if (!res.ok) throw new Error(`The API answered ${res.status}.`);
  revalidatePath("/approvals");
  revalidatePath("/");
}
