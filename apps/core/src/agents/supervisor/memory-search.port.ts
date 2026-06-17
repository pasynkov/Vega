// Decoupling port. The supervisor module needs to read memory hints in the
// pre-supervisor node but does not own the memory persistence layer. The
// memory module binds its MemoryService to this token.

export const MEMORY_SEARCH_PORT = Symbol("MEMORY_SEARCH_PORT");

export interface MemorySearchPort {
  searchTopK(query: string, k: number): Promise<{ content: string }[]>;
}
