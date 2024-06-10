import globals from "globals"
import pluginJs from "@eslint/js"

export default [
  {
    files: ["index.js"],
    languageOptions: { globals: globals.node },
    rules: {
      ...pluginJs.configs.recommended.rules,
      "no-unused-vars": "warn",
    },
  },
]
