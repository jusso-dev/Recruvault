import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Warm Ledger primitives. Neutrals ride the stone ramp; the oxblood accent
 * (focus rings, links, active state) is reserved and never decorative. */

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold",
    "transition-[background-color,color,box-shadow] duration-150 ease-out",
    "disabled:pointer-events-none disabled:opacity-50",
    focusRing,
  ),
  {
    variants: {
      variant: {
        // Ink: the default primary action.
        default: "bg-stone-900 text-stone-50 hover:bg-stone-800 shadow-sm",
        // Oxblood: reserved for the single most consequential action on a surface.
        accent: "bg-accent text-accent-fg hover:bg-accent-hover shadow-sm",
        secondary:
          "bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 hover:border-stone-400 shadow-sm",
        destructive: "bg-red-700 text-white hover:bg-red-800 shadow-sm",
        ghost: "text-stone-600 hover:bg-stone-100 hover:text-stone-900",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-6 text-[0.95rem]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

const fieldBase = cn(
  "flex w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900",
  "placeholder:text-stone-400 shadow-sm transition-colors",
  "focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/40",
  "disabled:opacity-50",
);

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, "h-10", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-20", className)} {...props} />;
}

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldBase, "h-10", className)} {...props} />;
}

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1.5 block text-sm font-medium text-stone-700", className)}
      {...props}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(41,37,36,0.04),0_1px_1px_rgba(41,37,36,0.03)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-b border-stone-100 px-5 py-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-[0.9rem] font-semibold tracking-tight text-stone-900", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-stone-200 bg-stone-100 text-stone-700",
        green: "border-emerald-200 bg-emerald-50 text-emerald-800",
        amber: "border-amber-200 bg-amber-50 text-amber-800",
        red: "border-red-200 bg-red-50 text-red-800",
        blue: "border-sky-200 bg-sky-50 text-sky-800",
        accent: "border-accent-tint-border bg-accent-tint text-accent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function statusBadgeVariant(
  status: string,
): "default" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "open":
    case "accepted":
    case "clean":
    case "sent":
    case "submitted":
      return "green";
    case "closing_soon":
    case "under_review":
    case "pending":
    case "follow_up":
    case "started":
      return "amber";
    case "closed":
    case "infected":
    case "bounced":
    case "failed":
      return "red";
    case "received":
    case "opened":
      return "blue";
    default:
      return "default";
  }
}
