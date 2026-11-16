export default function Loading({ text = 'Loading...' }: { text?: string }) {
  return (
    <p className="loading" role="status">
      {text}
    </p>
  );
}
