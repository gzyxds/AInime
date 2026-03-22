"use client";

import { useEffect } from "react";
import { initUserId } from "@/lib/fingerprint";

export function FingerprintProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    initUserId();
  }, []);

  return <>{children}</>;
}
