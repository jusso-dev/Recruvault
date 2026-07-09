"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await authClient.signOut();
        router.push("/");
      }}
    >
      Sign out
    </Button>
  );
}
