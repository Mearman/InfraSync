export default {
  // Invoke eslint via node directly — avoids pnpm/tinyexec deadlock with projectService: true
  "*.{ts,tsx}": ["node ./node_modules/.bin/eslint --fix --cache"],
  "*.json": ["node ./node_modules/.bin/eslint --fix --cache"],
  "*.md": ["node ./node_modules/.bin/eslint --fix --cache"],
};
