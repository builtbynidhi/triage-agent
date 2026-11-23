/** A collapsible, scrollable JSON view. Native <details>, so it works without any client code. */
export function JsonBlock({
  label,
  value,
  open = false,
}: {
  label: string;
  value: unknown;
  open?: boolean;
}) {
  return (
    <details open={open} className="group rounded border border-line bg-surface">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-sm text-muted hover:text-fg">
        {label}
      </summary>
      <pre className="max-h-96 overflow-auto border-t border-line px-3 py-2 font-mono text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
