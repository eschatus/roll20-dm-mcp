// double-metaphone@1 ships no types. CJS default export: a function returning the
// [primary, secondary] phonetic codes for a word.
declare module "double-metaphone" {
  const doubleMetaphone: (value: string) => [string, string];
  export default doubleMetaphone;
}
