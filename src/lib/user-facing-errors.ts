const FALLBACK = "We couldn’t complete that. Please try again.";

function errorText(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return error.message.trim();
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.trim();
  }
  return "";
}

/**
 * Converts errors from actions and third-party clients into calm, actionable
 * UI copy. Unknown technical details never reach the interface.
 */
export function userFacingError(error: unknown, fallback = FALLBACK): string {
  const raw = errorText(error);
  if (!raw) return fallback;
  const message = raw.toLowerCase();

  if (
    message.includes("invalid email or password") ||
    message.includes("invalid credentials") ||
    message.includes("incorrect password") ||
    message.includes("user not found")
  ) {
    return "We couldn’t sign you in. Check your email and password, then try again.";
  }
  if (message.includes("email") && message.includes("already")) {
    return "An account already uses this email. Try signing in instead.";
  }
  if (message.includes("recruiter self-registration is closed")) {
    return "Recruiter registration is closed. The first organisation owner must use the setup page.";
  }
  if (message.includes("passkey") && /(cancel|abort|not allowed)/.test(message)) {
    return "Passkey sign-in was cancelled. You can try again or use your password.";
  }
  if (/(too many|rate.?limit)/.test(message)) {
    return "There have been too many attempts. Wait a few minutes, then try again.";
  }
  if (/(failed to fetch|network|load failed|econn|connection)/.test(message)) {
    return "We couldn’t connect right now. Check your connection and try again.";
  }
  if (/(session has expired|session expired|sign in required)/.test(message)) {
    return "Your session has ended. Sign in again to continue.";
  }
  if (
    message.includes("role does not allow") ||
    message.includes("not authorised") ||
    message.includes("not authorized") ||
    message.includes("permission")
  ) {
    return "You don’t have permission to do that. Ask your organisation owner if you need access.";
  }
  if (message.includes("verify your email") || message === "verification required.") {
    return "Please verify your email address before continuing.";
  }
  if (message === "not found." || /^(request|submission|membership|key|role) not found\.?$/.test(message)) {
    return "We couldn’t find that item. It may have been removed or you may no longer have access.";
  }
  if (message.includes("invalid status") || message.includes("invalid role")) {
    return "That option is no longer available. Refresh the page and try again.";
  }
  if (message.includes("invalid token") || message.includes("token expired")) {
    return "This reset link is invalid or has expired. Request a new one to continue.";
  }
  if (message.includes("password too short")) {
    return "Use at least eight characters for your new password.";
  }
  if (message.includes("unknown credential type") || message.includes("unknown document type")) {
    return "That option is no longer available. Refresh the page and choose another one.";
  }

  const looksTechnical =
    raw.length > 220 ||
    /(typeerror|referenceerror|syntaxerror|sql|constraint|relation .* does not exist|stack|digest|\bat .+\(.+:\d+:\d+\)|\([a-z:_-]+\)$)/i.test(
      raw,
    );
  return looksTechnical ? fallback : raw;
}
