import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/test-results/**"] },
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    rules: {
      "vue/multi-word-component-names": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-indent": "off",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  prettier,
);
