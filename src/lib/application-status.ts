export const RECRUITER_APPLICATION_STATUSES = [
  "received",
  "under_review",
  "shortlisted",
  "interview",
  "offer",
  "accepted",
  "placed",
  "follow_up",
  "declined",
  "withdrawn",
] as const;

export type RecruiterApplicationStatus = (typeof RECRUITER_APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABELS: Record<string, string> = {
  started: "Draft",
  received: "Application received",
  under_review: "Under review",
  shortlisted: "Shortlisted",
  interview: "Interview",
  offer: "Offer",
  accepted: "Offer accepted",
  placed: "Placed",
  follow_up: "More information needed",
  declined: "Not progressing",
  withdrawn: "Withdrawn",
};

export const ACTIVE_APPLICATION_STATUSES = [
  "started",
  "received",
  "under_review",
  "shortlisted",
  "interview",
  "offer",
  "accepted",
  "follow_up",
] as const;

export function applicationStatusLabel(status: string) {
  return APPLICATION_STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}
