function Bar({ className }: { className: string }) {
  return <span className={`block rounded bg-stone-200/80 ${className}`} />;
}

export function DashboardSkeleton() {
  return (
    <div className="animate-pulse space-y-8" aria-label="Loading dashboard" aria-busy="true">
      <div className="space-y-3">
        <Bar className="h-3 w-28" />
        <Bar className="h-8 w-72 max-w-full" />
        <Bar className="h-3 w-[28rem] max-w-full" />
      </div>

      <div className="grid overflow-hidden rounded-lg border border-stone-200 bg-white sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-3 border-stone-100 px-6 py-5 sm:border-l first:sm:border-l-0">
            <Bar className="h-2.5 w-24" />
            <Bar className="h-7 w-32" />
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <div className="rounded-lg border border-stone-200 bg-white p-5">
          <Bar className="h-4 w-36" />
          <Bar className="mt-2 h-3 w-48" />
          <Bar className="mt-8 h-40 w-full rounded-md" />
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-5">
          <Bar className="h-4 w-32" />
          <Bar className="mt-2 h-3 w-44" />
          <div className="mt-8 space-y-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Bar key={index} className="h-3 w-full" />
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-100 p-5">
          <Bar className="h-4 w-32" />
        </div>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_100px] gap-5 border-b border-stone-100 px-5 py-4 last:border-b-0">
            <div className="space-y-2">
              <Bar className="h-3.5 w-2/5" />
              <Bar className="h-3 w-3/5" />
            </div>
            <Bar className="h-6 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
