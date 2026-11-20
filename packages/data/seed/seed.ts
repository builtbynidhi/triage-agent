import type { Db } from "../src/sqlite/db.ts";
import { indexPolicies, loadPolicies } from "../src/policies.ts";

/** Fixed "today" for every seeded date, so the seed and all date-window tests are deterministic. */
export const SEED_TODAY = "2026-11-20";

const DAY = 86_400_000;
export function dateMinus(days: number, from: string = SEED_TODAY): string {
  return new Date(Date.parse(from) - days * DAY).toISOString().slice(0, 10);
}

const TENANTS = [
  { id: "tenant_a", name: "Kaveri Home & Kitchen", prefix: "A", base: 10401, offset: 0 },
  { id: "tenant_b", name: "Nilgiri Electronics", prefix: "B", base: 20401, offset: 4 },
];

const FIRST = [
  "Asha",
  "Rohan",
  "Priya",
  "Vikram",
  "Meera",
  "Arjun",
  "Sneha",
  "Karan",
  "Divya",
  "Imran",
];
const LAST = ["Sharma", "Iyer", "Patel", "Reddy", "Nair", "Singh", "Das", "Khan", "Mehta", "Joshi"];
const TIERS = ["standard", "standard", "standard", "plus", "vip"] as const;

const CATALOG: Record<string, { sku: string; name: string; price: number }[]> = {
  tenant_a: [
    { sku: "KT-BL-01", name: "Stone blender 600W", price: 2499 },
    { sku: "KT-KT-02", name: "Steel electric kettle 1.5L", price: 1299 },
    { sku: "KT-PN-03", name: "Non-stick frying pan", price: 899 },
    { sku: "KT-CS-04", name: "Cast iron skillet", price: 1799 },
    { sku: "HM-BD-05", name: "Cotton bedsheet set", price: 1599 },
    { sku: "HM-LM-06", name: "Bedside lamp", price: 749 },
  ],
  tenant_b: [
    { sku: "EL-HP-01", name: "Wireless headphones", price: 3499 },
    { sku: "EL-PB-02", name: "Power bank 20000mAh", price: 1999 },
    { sku: "EL-SW-03", name: "Smartwatch Fit 2", price: 5999 },
    { sku: "EL-CB-04", name: "USB-C cable 1m", price: 399 },
    { sku: "EL-SP-05", name: "Bluetooth speaker", price: 2799 },
    { sku: "EL-TV-06", name: "Smart TV 43 inch", price: 28999 },
  ],
};

type Status = "placed" | "dispatched" | "delivered" | "cancelled" | "returned";

/**
 * 25 orders per tenant. `ago` is days before SEED_TODAY for the order's defining event.
 * Delivered orders deliberately straddle the policy windows: 6/7/8 days sit on the 7-day
 * return boundary and 13/14/15 on the 14-day refund boundary (delivery day is day 0).
 */
function plan(tenantIdx: number): { status: Status; ago: number }[] {
  const delivered =
    tenantIdx === 0
      ? [0, 2, 4, 6, 7, 8, 10, 13, 14, 15, 18, 25]
      : [1, 3, 5, 6, 7, 8, 11, 13, 14, 15, 20, 30];
  return [
    ...[0, 0, 1, 2].map((ago) => ({ status: "placed" as const, ago })),
    ...[1, 1, 2, 3].map((ago) => ({ status: "dispatched" as const, ago })),
    ...delivered.map((ago) => ({ status: "delivered" as const, ago })),
    ...[4, 6, 9].map((ago) => ({ status: "cancelled" as const, ago })), // ago = day placed
    ...[9, 12].map((ago) => ({ status: "returned" as const, ago })), // ago = day delivered
  ];
}

/** Child-first, so foreign keys allow the wipe. Seeding resets all data, including runs. */
const WIPE_ORDER = [
  "jobs",
  "approvals",
  "run_steps",
  "runs",
  "tickets",
  "order_items",
  "orders",
  "customers",
  "tenants",
];

/** Reset reference data and policy index to the deterministic seed. */
export function seed(db: Db, policiesDir?: string): void {
  db.transaction(() => {
    for (const t of WIPE_ORDER) db.exec(`DELETE FROM ${t}`);

    const insTenant = db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)");
    const insCustomer = db.prepare(
      "INSERT INTO customers (id, tenant_id, name, email, phone, tier) VALUES (?,?,?,?,?,?)",
    );
    const insOrder = db.prepare(
      `INSERT INTO orders (id, tenant_id, customer_id, status, placed_at, dispatched_at, delivered_at,
         cancelled_at, returned_at, total, currency) VALUES (?,?,?,?,?,?,?,?,?,?, 'INR')`,
    );
    const insItem = db.prepare(
      "INSERT INTO order_items (order_id, sku, name, qty, unit_price) VALUES (?,?,?,?,?)",
    );

    TENANTS.forEach((t, ti) => {
      insTenant.run(t.id, t.name);

      const customerIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const first = FIRST[i]!;
        const last = LAST[(i * 3 + t.offset) % 10]!;
        const id = `cust_${t.prefix.toLowerCase()}_${String(i + 1).padStart(2, "0")}`;
        const phone = `+91 9${String(100_000_000 + (((i + 1) * 7_654_321 + ti * 1_111_111) % 900_000_000))}`;
        const email = `${first}.${last}${i + 1}@example.com`.toLowerCase();
        insCustomer.run(id, t.id, `${first} ${last}`, email, phone, TIERS[i % TIERS.length]!);
        customerIds.push(id);
      }

      plan(ti).forEach((p, i) => {
        const id = `${t.prefix}-${t.base + i}`;
        let placed: string,
          dispatched: string | null = null,
          delivered: string | null = null;
        let cancelled: string | null = null,
          returned: string | null = null;
        switch (p.status) {
          case "placed":
            placed = dateMinus(p.ago);
            break;
          case "dispatched":
            dispatched = dateMinus(p.ago);
            placed = dateMinus(p.ago + 1);
            break;
          case "delivered":
            delivered = dateMinus(p.ago);
            dispatched = dateMinus(p.ago + 3);
            placed = dateMinus(p.ago + 4);
            break;
          case "cancelled":
            placed = dateMinus(p.ago);
            cancelled = dateMinus(p.ago - 1);
            break;
          case "returned":
            delivered = dateMinus(p.ago);
            dispatched = dateMinus(p.ago + 3);
            placed = dateMinus(p.ago + 4);
            returned = dateMinus(p.ago - 5);
            break;
        }

        const catalog = CATALOG[t.id]!;
        const lines = Array.from({ length: 1 + (i % 3) }, (_, k) => ({
          ...catalog[(i * 2 + k) % catalog.length]!,
          qty: k === 0 && i % 5 === 0 ? 2 : 1,
        }));
        const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);

        insOrder.run(
          id,
          t.id,
          customerIds[i % customerIds.length]!,
          p.status,
          placed,
          dispatched,
          delivered,
          cancelled,
          returned,
          total,
        );
        for (const l of lines) insItem.run(id, l.sku, l.name, l.qty, l.price);
      });
    });

    indexPolicies(db, loadPolicies(policiesDir));
  })();
}
