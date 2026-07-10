import Image from "next/image";
import { cn } from "@/lib/utils";

export function BrandMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/brand/recruvault-mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
