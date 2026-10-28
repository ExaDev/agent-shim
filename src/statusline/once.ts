/** `read`, run on first call and its result kept, so every later call returns that result without running it again. */
export function once<T>(read: () => T): () => T {
  let kept: { readonly value: T } | undefined;
  return () => {
    kept ??= { value: read() };
    return kept.value;
  };
}
