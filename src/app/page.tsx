import { BriefcaseBusiness, Files, ShieldCheck } from "lucide-react";
import { ButtonLink, Card, CardContent } from "@/components/ui";

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
            <ButtonLink href="/sign-in" variant="ghost">Sign in</ButtonLink>
            <ButtonLink href="/sign-up">Get started</ButtonLink>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          From application to placement.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-stone-600">
          Recruvault gives recruiters a clear candidate pipeline and gives job seekers
          one place for applications, resumes, cover letters, and credentials. Sensitive
          information stays encrypted, consented, and auditable throughout.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <ButtonLink href="/sign-up?type=org" size="lg">I&apos;m a recruiter</ButtonLink>
          <ButtonLink href="/sign-up?type=seeker" size="lg" variant="secondary">
            I&apos;m a job seeker
          </ButtonLink>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-4 pb-16 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-2">
            <BriefcaseBusiness className="h-6 w-6" aria-hidden />
            <h2 className="font-semibold">A placement pipeline</h2>
            <p className="text-sm text-stone-600">
              Recruiters see every active role and move candidates through review,
              shortlist, interview, offer, and placement.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2">
            <Files className="h-6 w-6" aria-hidden />
            <h2 className="font-semibold">Applications in one place</h2>
            <p className="text-sm text-stone-600">
              Job seekers track progress across roles and keep current resumes, cover
              letters, and selection responses ready to reuse.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2">
            <ShieldCheck className="h-6 w-6" aria-hidden />
            <h2 className="font-semibold">Secure by design</h2>
            <p className="text-sm text-stone-600">
              Candidate documents and credentials move through encrypted, expiring,
              audited channels with explicit consent and revocable sharing.
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
