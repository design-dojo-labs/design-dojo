/// <reference types="vite/client" />

declare module 'monaco-editor/esm/vs/editor/edcore.main.js' {
  export * from 'monaco-editor';
}
declare module 'monaco-editor/esm/vs/basic-languages/*';
declare module 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
declare module 'monaco-editor/esm/vs/editor/editor.worker.js?worker' {
  const W: new () => Worker;
  export default W;
}
declare module 'monaco-editor/esm/vs/language/json/json.worker.js?worker' {
  const W: new () => Worker;
  export default W;
}
