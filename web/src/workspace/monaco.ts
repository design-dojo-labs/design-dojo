// Monaco is bundled locally (no CDN): editor core + the languages a Maven project needs.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

const read = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Defines editor themes from the studio's CSS tokens so the editor matches the surrounding UI. */
export function applyMonacoTheme(dark: boolean): void {
  const bg = read('--c-sunken') || (dark ? '#161c1b' : '#eceeea');
  const panel = read('--c-panel');
  const ink = read('--c-ink');
  const faint = read('--c-faint');
  const line = read('--c-line');
  const select = read('--c-select');
  const name = dark ? 'studio-dark' : 'studio-light';
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: dark
      ? [
          { token: 'keyword', foreground: 'D9A441' },
          { token: 'string', foreground: '9CC79A' },
          { token: 'comment', foreground: '6B7C77', fontStyle: 'italic' },
          { token: 'number', foreground: 'C9A0DC' },
          { token: 'annotation', foreground: '7FB8D4' },
          { token: 'type', foreground: '8FD0C4' },
        ]
      : [
          { token: 'keyword', foreground: '8A5A10' },
          { token: 'string', foreground: '2C7A3A' },
          { token: 'comment', foreground: '84918C', fontStyle: 'italic' },
          { token: 'number', foreground: '7A3E9D' },
          { token: 'annotation', foreground: '2C6E8F' },
        ],
    colors: {
      'editor.background': panel || bg,
      'editor.foreground': ink,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': ink,
      'editor.lineHighlightBackground': dark ? '#26302e' : '#f0f3ef',
      'editor.selectionBackground': dark ? '#35504a' : '#cfe0d8',
      'editorIndentGuide.background1': line,
      'editorGutter.background': panel || bg,
      'editorWidget.background': read('--c-raised'),
      'editorWidget.border': read('--c-line-strong'),
      'list.hoverBackground': select,
      'diffEditor.insertedTextBackground': dark ? '#62b99b2e' : '#2c7f6026',
      'diffEditor.removedTextBackground': dark ? '#e2705e2e' : '#b8402f22',
    },
  });
  monaco.editor.setTheme(name);
}

export function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'java':
      return 'java';
    case 'xml':
      return 'xml';
    case 'md':
      return 'markdown';
    case 'json':
      return 'json';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sh':
      return 'shell';
    default:
      return 'plaintext';
  }
}

export { monaco };
