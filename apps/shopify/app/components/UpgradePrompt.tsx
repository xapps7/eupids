// UC-15: shown when a fixing action is blocked by the plan.
export type Upgrade = { reason: "free_plan" | "variant_cap" | "supplier_cap"; needed: string; next: string };

const REASON: Record<Upgrade["reason"], string> = {
  free_plan: "Scanning is free. Fixing items from inside the app needs a paid plan.",
  variant_cap: "Your store has more variants than your plan covers.",
  supplier_cap: "Your plan’s supplier request limit is reached.",
};

export function UpgradePrompt({ upgrade }: { upgrade: Upgrade }) {
  const href = `/app/billing?plan=${upgrade.needed}&next=${encodeURIComponent(upgrade.next)}`;
  return (
    <s-banner tone="warning" heading="Upgrade to continue">
      <s-paragraph>{REASON[upgrade.reason]} Your change is kept and will finish after you approve the plan.</s-paragraph>
      <s-button variant="primary" href={href}>See plans</s-button>
    </s-banner>
  );
}
