import { cn } from "@/lib/utils";

export function BrandMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    // A plain image, not next/image: the optimizer writes style="color:transparent",
    // which the production style-src nonce rejects.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/recruvault-mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
