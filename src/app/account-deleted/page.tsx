export default function AccountDeletedPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold">This account has been deleted</h1>
        <p className="text-sm leading-6 text-stone-600">
          Sign-in methods, sessions, and API keys were revoked, and the encryption keys
          for your career record were destroyed. Stored files are removed in the
          background. This account cannot sign in again; registering later with the same
          email starts a new, empty account. Backups taken before deletion can still hold
          ciphertext until they expire, and that ciphertext cannot be opened after the
          keys were destroyed.
        </p>
      </div>
    </main>
  );
}
