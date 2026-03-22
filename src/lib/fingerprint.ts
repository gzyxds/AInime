const STORAGE_KEY = "ai_comic_uid";
const COOKIE_NAME = "ai_comic_uid";

async function buildFingerprint(): Promise<string> {
  const signals = [
    navigator.userAgent,
    navigator.language,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).userAgentData?.platform ?? (navigator as any).platform ?? "",
    String(screen.width),
    String(screen.height),
    String(screen.colorDepth),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency ?? ""),
  ].join("|");

  const encoder = new TextEncoder();
  const data = encoder.encode(signals);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getUserId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

function setUserCookie(userId: string) {
  const maxAge = 365 * 24 * 60 * 60;
  document.cookie = `${COOKIE_NAME}=${userId}; max-age=${maxAge}; path=/; SameSite=Lax`;
}

export async function initUserId(): Promise<string> {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) {
    setUserCookie(existing);
    return existing;
  }

  const fp = await buildFingerprint();
  localStorage.setItem(STORAGE_KEY, fp);
  setUserCookie(fp);
  return fp;
}
