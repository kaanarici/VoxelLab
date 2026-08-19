function normalizeError(error) {
  if (error instanceof Error) return error;
  return new Error(String(error || 'Unknown error'));
}

export async function softFail(promise, label) {
  try {
    return await promise;
  } catch (error) {
    const err = normalizeError(error);
    console.error(`[${label}]`, err);
    return null;
  }
}
