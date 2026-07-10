import Link from "next/link";
import { Button } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-sm text-stone-600">
        The page you&apos;re looking for doesn&apos;t exist or may have expired.
      </p>
      <Link href="/">
        <Button>Go home</Button>
      </Link>
    </main>
  );
}
