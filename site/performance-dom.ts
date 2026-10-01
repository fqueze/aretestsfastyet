// Typed access to required elements; missing markup should fail explicitly.
export function element<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing element: ${id}`);
    return node as T;
}
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
