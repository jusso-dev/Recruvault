export default function AccountDeletedPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold">This account has been deleted</h1>
        <p className="text-sm leading-6 text-stone-600">
          Career records, sessions, and API keys were revoked. Signing in does not
          create a new career record for this login. Backups taken before deletion can
          still hold ciphertext until they expire, and that ciphertext cannot be opened
          after the keys were destroyed.
        </p>
      </div>
    </main>
  );
}
