// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  reporter: [['html', { outputFolder: 'playwright-report', open: 'always' }]],
});
