export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="json">
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}
