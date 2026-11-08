# Keep this tag aligned with the pinned Playwright dependency. The image includes
# Chromium and its Linux system dependencies for local container execution.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Fail the build if the installed Playwright cannot launch the bundled Chromium.
RUN node --input-type=module -e "import { connectBrowser, closeBrowser } from './lib/browser.js'; const browser = await connectBrowser(); await closeBrowser(browser);"

EXPOSE 3000

CMD ["npm", "run", "serve"]
