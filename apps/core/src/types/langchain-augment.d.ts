// Bridge: TypeScript with classic `node` moduleResolution does not read the
// `exports` map in @langchain/langgraph/package.json, so importing from
// "@langchain/langgraph/prebuilt" fails to resolve types. The runtime CJS
// resolver (Node, vite/vitest) honors the exports map and resolves it fine.
//
// Switching the whole project to node16/bundler moduleResolution would
// require .js extensions on every relative import (node16) or breaking the
// CJS module setting (bundler). This declaration is the minimal bridge.

declare module "@langchain/langgraph/prebuilt" {
  export * from "@langchain/langgraph/dist/prebuilt/react_agent_executor";
}
