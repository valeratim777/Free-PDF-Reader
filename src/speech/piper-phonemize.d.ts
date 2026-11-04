// The phonemizer (eSpeak NG compiled to WebAssembly) ships without type information.
declare module '@diffusionstudio/piper-wasm/build/piper_phonemize.js' {
  interface Options {
    print?(line: string): void;
    printErr?(line: string): void;
    locateFile?(file: string): string;
    noInitialRun?: boolean;
  }
  const createPiperPhonemize: (options: Options) => Promise<{ callMain(args: string[]): void }>;
  export default createPiperPhonemize;
}
