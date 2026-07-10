"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BriefcaseBusiness,
  Braces,
  ClipboardList,
  FileClock,
  Files,
  LayoutDashboard,
  BellRing,
  Settings2,
  ShieldCheck,
  type LucideIcon,
  WalletCards,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SignOutButton } from "@/components/sign-out";

export type AppNavIcon =
  | "overview"
  | "requests"
  | "audit"
  | "settings"
  | "documents"
  | "wallet"
  | "roles"
  | "integrations"
  | "alerts";

export interface AppNavItem {
  href: string;
  label: string;
  icon: AppNavIcon;
  exact?: boolean;
}

const ICONS: Record<AppNavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  requests: ClipboardList,
  audit: FileClock,
  settings: Settings2,
  documents: Files,
  wallet: WalletCards,
  roles: BriefcaseBusiness,
  integrations: Braces,
  alerts: BellRing,
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function AppShell({
  children,
  brandHref,
  workspaceName,
  workspaceMeta,
  userName,
  nav,
}: {
  children: ReactNode;
  brandHref: string;
  workspaceName: string;
  workspaceMeta: string;
  userName: string;
  nav: AppNavItem[];
}) {
  const pathname = usePathname();

  const activeHref = nav
    .filter((item) =>
      item.exact
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const navigation = (
    <nav aria-label="Primary" className="flex gap-1 lg:flex-col">
      {nav.map((item) => {
        const Icon = ICONS[item.icon];
        const active = activeHref === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex min-h-10 shrink-0 items-center gap-3 rounded-md px-3 text-sm font-medium",
              "transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              active
                ? "bg-stone-900 text-stone-50"
                : "text-stone-600 hover:bg-stone-200/70 hover:text-stone-950",
            )}
          >
            <Icon
              className={cn("h-[18px] w-[18px]", active ? "text-stone-50" : "text-stone-500")}
              strokeWidth={1.8}
              aria-hidden
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-stone-200 bg-stone-100/65 lg:flex">
        <div className="border-b border-stone-200 px-5 py-5">
          <Link
            href={brandHref}
            className="flex w-fit items-center gap-2.5 rounded-sm font-semibold tracking-[-0.02em] text-stone-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-tint text-accent ring-1 ring-accent-tint-border">
              <ShieldCheck className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
            </span>
            <span>Recruvault</span>
          </Link>
        </div>

        <div className="px-5 pb-5 pt-4">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-stone-400">
            Workspace
          </p>
          <p className="mt-2 truncate text-sm font-semibold text-stone-900">{workspaceName}</p>
          <p className="mt-0.5 text-xs capitalize text-stone-500">{workspaceMeta}</p>
        </div>

        <div className="flex-1 px-3">{navigation}</div>

        <div className="border-t border-stone-200 p-3">
          <div className="flex items-center gap-3 rounded-md px-2 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-200 text-xs font-semibold text-stone-700">
              {initials(userName)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-stone-800">{userName}</p>
              <p className="text-xs text-stone-500">Signed in</p>
            </div>
            <SignOutButton />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-stone-200 bg-background/95 lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <Link href={brandHref} className="flex items-center gap-2 font-semibold tracking-tight">
              <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
              Recruvault
            </Link>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-stone-500 sm:inline">{workspaceName}</span>
              <SignOutButton />
            </div>
          </div>
          <div className="overflow-x-auto px-3 pb-2">{navigation}</div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 xl:px-10">
          {children}
        </main>
      </div>
    </div>
  );
}
