/**
 * Convert a local file path (e.g., "./uploads/frames/abc.png") to an API URL
 * for serving via /api/uploads/[...path].
 */
export function uploadUrl(filePath: string): string {
  // Strip any prefix ending with "uploads/" (handles ./uploads/, /app/uploads/, etc.)
  return `/api/uploads/${filePath.replace(/^.*uploads\//, "")}`;
}
