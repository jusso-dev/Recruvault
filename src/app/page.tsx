import Link from "next/link";
import { ShieldCheck, Lock, FileCheck2, Wallet } from "lucide-react";
import { Button, Card, CardContent } from "@/components/ui";

export default function LandingPage() {
  return (
    <main className="flex-1">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2 font-semibold text-lg">
            <ShieldCheck className="h-6 w-6 text-accent" aria-hidden />
            Recruvault
          </div>
          <nav className="flex items-center gap-2">
            <Link href="/sign-in">
              <Button variant="ghost">Sign in</Button>
            </Link>
            <Link href="/sign-up">
              <Button>Get started</Button>
            </Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Cleared hiring, off email.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-stone-600">
          Recruvault is a secure exchange for recruiters and job seekers. Clearance
          details, identity documents, and right-to-work evidence move through an
          encrypted, expiring, audited vault, never as an email attachment.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/sign-up?type=org">
            <Button size="lg">I&apos;m a recruiter</Button>
          </Link>
          <Link href="/sign-up?type=seeker">
            <Button size="lg" variant="secondary">
              I&apos;m a job seeker
            </Button>
          </Link>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-4 pb-16 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-2">
            <Lock className="h-6 w-6" aria-hidden />
            <h2 className="font-semibold">Encrypted and expiring</h2>
            <p className="text-sm text-stone-600">
              Field-level encryption with per-record keys in AWS KMS (ap-southeast-2).
              Deletion is a crypto-shred: the key is destroyed, the data is gone.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2">
            <FileCheck2 className="h-6 w-6" aria-hidden />
            <h2 className="font-semibold">Audited end to end</h2>
            <p className="text-sm text-stone-600">
              Every open, view, download, and export lands in an append-only,
              hash-chained audit trail that stands up to a privacy review.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2">
            <Wallet className="h-6 w-6" aria-hidden />
            <h2 className="font-semibold">Your credentials, once</h2>
            <p className="text-sm text-stone-600">
              Job seekers keep clearance and ID details in a private wallet, reuse
              them across roles with explicit consent, and revoke future use anytime.
            </p>
          </CardContent>
        </Card>
      </section>

      <footer className="border-t border-stone-200 bg-white py-6 text-center text-sm text-stone-500">
        Recruvault handles candidate-declared information at OFFICIAL: Sensitive at
        most; never classified material. AU data residency by default.
      </footer>
    </main>
  );
}
