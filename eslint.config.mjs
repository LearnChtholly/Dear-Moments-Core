export default [
  {
    ignores: ["node_modules/**", "data/**", "coverage/**"],
  },
  {
    files: ["**/*.mjs", "public/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: Object.fromEntries(
        [
          "TextDecoder",
          "process",
          "console",
          "Buffer",
          "URL",
          "fetch",
          "AbortSignal",
          "AbortController",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "setImmediate",
          "structuredClone",
          "document",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" },
      ],
      "no-constant-condition": "error",
    },
  },
];
