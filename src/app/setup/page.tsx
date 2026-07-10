import { redirect } from "next/navigation";
import { db } from "@/db";
import { organisations } from "@/db/schema";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const [existing] = await db.select({ id: organisations.id }).from(organisations).limit(1);
  if (existing) redirect("/sign-in");

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10 sm:py-16">
      <SetupForm />
    </main>
  );
}
