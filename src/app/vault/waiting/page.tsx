export default function VaultWaitingPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold">Encryption setup is incomplete</h1>
        <p className="text-sm leading-6 text-stone-600">
          Ask the organisation owner to enroll the workspace encryption key. You cannot
          open career records until that is done.
        </p>
      </div>
    </main>
  );
}
