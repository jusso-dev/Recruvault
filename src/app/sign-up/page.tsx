import { Suspense } from "react";
import { connection } from "next/server";
import { SignUpForm } from "@/components/sign-up-form";
import { recruiterSignupEnabled } from "@/lib/signup-policy";

export default async function SignUpPage() {
  await connection();

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Suspense>
        <SignUpForm allowRecruiterSignup={recruiterSignupEnabled()} />
      </Suspense>
    </main>
  );
}
