/**
 * @file ErrorInline.tsx
 * @module admin-dashboard
 * @description Inline query/mutation error line.
 */

export function ErrorInline({ message }: { message?: string | null }) {
  if (!message) return null;
  return <p className="err">{message}</p>;
}
