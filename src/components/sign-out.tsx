"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";

export function SignOutButton() {
  const router = useRouter();
  const { showToast } = useToast();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        try {
          const result = await authClient.signOut();
          if (result.error) {
            showToast({
              tone: "error",
              message: userFacingError(result.error, "We couldn’t sign you out. Please try again."),
            });
            return;
          }
          router.push("/");
        } catch (error) {
          showToast({ tone: "error", message: userFacingError(error) });
        }
      }}
    >
      Sign out
    </Button>
  );
}
