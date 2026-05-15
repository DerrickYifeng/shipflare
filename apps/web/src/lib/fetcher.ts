export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  return (await res.json()) as T;
}
