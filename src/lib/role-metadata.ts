export const EMPLOYMENT_TYPES = ["permanent", "contract", "fixed_term", "casual"] as const;
export const WORK_ARRANGEMENTS = ["on_site", "hybrid", "remote"] as const;
export const SALARY_PERIODS = ["annual", "daily", "hourly"] as const;

export function roleMetadataLabel(value: string | null | undefined): string {
  if (!value) return "";
  const labels: Record<string, string> = {
    permanent: "Permanent",
    contract: "Contract",
    fixed_term: "Fixed term",
    casual: "Casual",
    on_site: "On-site",
    hybrid: "Hybrid",
    remote: "Remote",
    annual: "per year",
    daily: "per day",
    hourly: "per hour",
  };
  return labels[value] ?? value.replaceAll("_", " ");
}

export function formatSalaryRange(
  minimum: number | null,
  maximum: number | null,
  period: string | null,
): string | null {
  if (minimum === null && maximum === null) return null;
  const number = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  });
  const range =
    minimum !== null && maximum !== null
      ? `${number.format(minimum)}–${number.format(maximum)}`
      : minimum !== null
        ? `From ${number.format(minimum)}`
        : `Up to ${number.format(maximum!)}`;
  return `${range} ${roleMetadataLabel(period || "annual")}`;
}
