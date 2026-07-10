import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button, Card, CardContent } from "@/components/ui";

export default function DonePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 p-4">
      <Card className="w-full max-w-md text-center">
        <CardContent className="space-y-3 py-8">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" aria-hidden />
          <h1 className="text-lg font-semibold">Submitted securely</h1>
          <p className="text-sm text-stone-600">
            Your information is encrypted in the organisation&apos;s vault. A
            confirmation email with the retention period and how to request deletion is
            on its way.
          </p>
          <p className="text-sm text-stone-600">
            Want to reuse these details next time in one tap?
          </p>
          <Link href="/sign-up?type=seeker">
            <Button variant="secondary">Create a free wallet</Button>
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
