## Fix: `read_anthropic_billing` — Missing `starting_at` Parameter

### Files to Patch
1. `src/app/api/agents/[slug]/chat/route.ts`
2. `src/app/api/jobs/[id]/chat/route.ts`

---

### Step 1: Add helper function (both files, after imports)

```typescript
// ─── Billing helpers ────────────────────────────────────────────────────────

function getBillingStartingAt(period: "today" | "week" | "month"): number {
  const now = new Date();

  if (period === "today") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return Math.floor(start.getTime() / 1000);
  }

  if (period === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    start.setUTCHours(0, 0, 0, 0);
    return Math.floor(start.getTime() / 1000);
  }

  if (period === "month") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    return Math.floor(start.getTime() / 1000);
  }

  // Fallback: 30 days ago
  return Math.floor((now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000);
}
```

---

### Step 2: Update `read_anthropic_billing` case (both files)

```typescript
case "read_anthropic_billing": {
  const { period = "month", report_type = "both" } = toolInput as {
    period?: "today" | "week" | "month";
    report_type?: "usage" | "cost" | "both";
  };

  const starting_at = getBillingStartingAt(period);

  const [usageRes, costsRes] = await Promise.all([
    report_type !== "cost"
      ? fetch(
          `https://api.anthropic.com/v1/organizations/usage?starting_at=${starting_at}`,
          {
            headers: {
              "x-api-key": process.env.ANTHROPIC_ADMIN_API_KEY!,
              "anthropic-version": "2023-06-01",
            },
          }
        )
      : null,
    report_type !== "usage"
      ? fetch(
          `https://api.anthropic.com/v1/organizations/costs?starting_at=${starting_at}`,
          {
            headers: {
              "x-api-key": process.env.ANTHROPIC_ADMIN_API_KEY!,
              "anthropic-version": "2023-06-01",
            },
          }
        )
      : null,
  ]);

  const usageData = usageRes ? await usageRes.json() : null;
  const costsData = costsRes ? await costsRes.json() : null;

  toolResult = JSON.stringify({ period, starting_at, usage: usageData, costs: costsData });
  break;
}
```